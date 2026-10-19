#pragma once
// UI-5B2B: strict, offline, snapshot-backed WebView2 resource routing.
// Non-RT only. This is a byte lookup, NOT OS access, HTML permission, or
// authoritative bridge handshake. Never fall through to an unverified folder.
#include "ui_asset_snapshot.h"
#include <string>
#include <string_view>
#include <memory>
#include <cstddef>
#include <algorithm>
#include <utility>

namespace fw::ui_assets {
struct RoutedResource {
    const PinnedFile* file=nullptr;  // Lifetime owned by supplied snapshot.
    const char* mime=nullptr;
};
inline const char* mimeForPinnedPath(std::string_view name) noexcept {
    const auto dot=name.rfind('.');
    if(dot==std::string_view::npos)return nullptr;
    const auto e=name.substr(dot);
    if(e==".html"||e==".htm")return "text/html; charset=utf-8";
    if(e==".js"||e==".mjs")return "text/javascript; charset=utf-8";
    if(e==".css")return "text/css; charset=utf-8";
    if(e==".json")return "application/json";
    if(e==".wasm")return "application/wasm";
    if(e==".svg")return "image/svg+xml";
    if(e==".png")return "image/png";
    if(e==".jpg"||e==".jpeg")return "image/jpeg";
    if(e==".webp")return "image/webp";
    if(e==".gif")return "image/gif";
    if(e==".ico")return "image/x-icon";
    if(e==".woff")return "font/woff";
    if(e==".woff2")return "font/woff2";
    if(e==".ttf")return "font/ttf";
    if(e==".otf")return "font/otf";
    if(e==".txt")return "text/plain; charset=utf-8";
    return nullptr;
}
inline bool pinnedRelativeFromUrl(std::string_view url,
                                  std::string& result) noexcept {
    // No credentials, alternate ports, query/fragment or percent escapes.
    // JS imports use literal ASCII relative assets in the approved v1 set.
    constexpr std::string_view origin="https://fwvst.local/";
    if(url.size()<=origin.size()||url.substr(0,origin.size())!=origin||
       url.size()>origin.size()+4096)return false;
    const auto path=url.substr(origin.size());
    if(path.find_first_of("%?#\\")!=std::string_view::npos ||
       path.find("//")!=std::string_view::npos)return false;
    const std::string relative(path);
    if(!validPinnedRelativePath(relative)||
       !mimeForPinnedPath(relative))return false;
    result=relative;
    return true;
}
inline RoutedResource findPinnedResource(
    const std::shared_ptr<const PinnedSnapshot>& snapshot,
    std::string_view url) noexcept {
    if(!snapshot||snapshot->version!=1)return {};
    std::string path;
    if(!pinnedRelativeFromUrl(url,path))return {};
    const auto item=std::find_if(snapshot->files.begin(),snapshot->files.end(),
        [&](const PinnedFile& f){return f.path==path;});
    if(item==snapshot->files.end())return {};
    return {&*item,mimeForPinnedPath(item->path)};
}
} // namespace fw::ui_assets
