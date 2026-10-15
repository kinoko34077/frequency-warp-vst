#pragma once
// UI-5A: portable NON-RT policy for a candidate local UI directory.
// No file or page is activated by this inspection. The later native reload
// transaction must revalidate the exact bytes/version before switching.
// No OS permissions, remote URL, native process or RT callback is touched.
#include <algorithm>
#include <cctype>
#include <cstdint>
#include <filesystem>
#include <set>
#include <string>
#include <system_error>

namespace fw {
namespace ui_assets {
namespace fs=std::filesystem;
constexpr std::uintmax_t kMaxFileBytes=8ull*1024*1024;
constexpr std::uintmax_t kMaxTotalBytes=48ull*1024*1024;
constexpr std::size_t kMaxFiles=1024;
struct Candidate {
    std::size_t files=0;
    std::uintmax_t bytes=0;
    bool hasIndex=false;
};
// Allowed *files*, not an active trust model: HTML/JS remain untrusted until
// the native origin, script and worker/DAW permission gates are in force.
// Explicit allowlist means .exe/.dll, unknown and hidden dotfiles fail closed.
inline bool allowedExtension(const fs::path& p) {
    auto extension=p.extension().string();
    std::transform(extension.begin(),extension.end(),extension.begin(),
                   [](unsigned char c){return static_cast<char>(std::tolower(c));});
    static const std::set<std::string> allowed={
        ".html",".htm",".css",".js",".mjs",".json",".wasm",
        ".svg",".png",".jpg",".jpeg",".webp",".gif",".ico",
        ".woff",".woff2",".ttf",".otf",".txt"
    };
    return allowed.count(extension)!=0;
}
inline bool inspectCandidate(const fs::path& root,Candidate& out) noexcept {
    try {
        if(root.empty()||!fs::exists(root)||fs::is_symlink(fs::symlink_status(root))||
           !fs::is_directory(root))return false;
        Candidate checked{};
        auto iterator=fs::recursive_directory_iterator(
            root,fs::directory_options::none);
        const auto end=fs::recursive_directory_iterator{};
        for(;iterator!=end;++iterator) {
            const auto& entry=*iterator;
            const auto type=entry.symlink_status();
            if(fs::is_symlink(type))return false; // includes escaping symlinks
            if(fs::is_directory(type))continue;
            if(!fs::is_regular_file(type))return false;
            const auto relative=entry.path().lexically_relative(root);
            if(relative.empty()||relative.is_absolute()||
               relative.string().size()>4096||!allowedExtension(relative))
                return false;
            for(const auto& component:relative)
                if(component==".."||component==".")return false;
            const auto name=relative.filename().string();
            if(name.empty()||name.front()=='.')return false;
            const auto bytes=entry.file_size();
            if(bytes>kMaxFileBytes||checked.files>=kMaxFiles||
               bytes>kMaxTotalBytes-checked.bytes)return false;
            ++checked.files;
            checked.bytes+=bytes;
            if(relative==fs::path("index.html")) {
                if(!bytes)return false;
                checked.hasIndex=true;
            }
        }
        if(!checked.hasIndex||checked.files==0)return false;
        out=checked; // only successful full inspections mutate the result
        return true;
    } catch(...) {
        return false;
    }
}
} // namespace ui_assets
} // namespace fw
