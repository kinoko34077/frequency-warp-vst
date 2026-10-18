#pragma once
// UI-5B2B local manifest wire grammar. Parsing bytes is NOT approving origin.
// Native code must obtain this file via OS picker and require explicit
// confirmation; never trust a manifest supplied by the webpage or UI root.
#include "ui_asset_snapshot.h"
#include <charconv>
#include <string>
#include <string_view>
#include <set>
#include <limits>

namespace fw::ui_assets {
inline bool parseApprovedManifest(std::string_view input,
                                  TrustedManifest& output) noexcept {
    constexpr std::string_view magic="FWUI-MANIFEST-V1\n";
    if(input.size()<magic.size()||input.size()>1024*1024 ||
       input.substr(0,magic.size())!=magic)return false;
    try {
        TrustedManifest parsed{};
        parsed.version=1;
        std::uintmax_t total=0;
        std::set<std::string> aliases;
        bool index=false,bridge=false;
        std::size_t i=magic.size();
        while(i<input.size()){
            const auto end=input.find('\n',i);
            if(end==std::string_view::npos)return false;
            auto line=input.substr(i,end-i);
            i=end+1;
            if(!line.empty()&&line.back()=='\r')line.remove_suffix(1);
            if(line.empty()||parsed.files.size()>=kMaxFiles)return false;
            const auto first=line.find('\t');
            const auto last=line.rfind('\t');
            if(first==std::string_view::npos||last==first)return false;
            const std::string path(line.substr(0,first));
            if(!validPinnedRelativePath(path)||
               !allowedExtension(fs::path(path))||
               !aliases.insert(casefoldAscii(path)).second)return false;
            const auto count=line.substr(first+1,last-first-1);
            if(count.empty()||count.front()=='+'||count.front()=='-'||
               (count.size()>1&&count.front()=='0'))return false;
            std::uintmax_t bytes=0;
            const auto parse=std::from_chars(count.data(),
                count.data()+count.size(),bytes);
            if(parse.ec!=std::errc{}||parse.ptr!=count.data()+count.size()||
               bytes>kMaxFileBytes||bytes>kMaxTotalBytes-total)return false;
            total+=bytes;
            const auto hex=line.substr(last+1);
            if(hex.size()!=64)return false;
            ExpectedFile item{};
            item.path=path;item.bytes=bytes;
            for(std::size_t b=0;b<32;b++){
                const auto decode=[](char c)->int{
                    if(c>='0'&&c<='9')return c-'0';
                    if(c>='a'&&c<='f')return c-'a'+10;
                    if(c>='A'&&c<='F')return c-'A'+10;
                    return -1;
                };
                const int hi=decode(hex[b*2]),lo=decode(hex[b*2+1]);
                if(hi<0||lo<0)return false;
                item.sha256[b]=static_cast<std::uint8_t>((hi<<4)|lo);
            }
            index|=(path=="index.html"&&bytes>0);
            bridge|=(path=="host-bridge.mjs"&&bytes>0);
            parsed.files.push_back(std::move(item));
        }
        if(!index||!bridge)return false;
        output=std::move(parsed);
        return true;
    }catch(...){return false;}
}
} // namespace fw::ui_assets
