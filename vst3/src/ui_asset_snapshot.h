#pragma once
// UI-5B1: stage EXACT, trusted-manifest-pinned local UI bytes off the audio
// thread. This is a candidate-only transaction: no WebView navigation,
// authorization, JS/OS capability or DAW state is changed here.
// Content SHA-256 proves identity against an independently approved manifest,
// NOT origin authenticity or publisher signature.
#include "ui_asset_policy.h"
#include <array>
#include <cstdint>
#include <filesystem>
#include <fstream>
#include <memory>
#include <set>
#include <string>
#include <vector>
#include <utility>

namespace fw::ui_assets {
struct ExpectedFile {
    std::string path; // portable relative ASCII, '/' separator
    std::uintmax_t bytes=0;
    std::array<std::uint8_t,32> sha256{};
};
struct TrustedManifest {
    std::uint32_t version=0; // first accepted contract is 1
    std::vector<ExpectedFile> files;
};
struct PinnedFile {
    std::string path;
    std::vector<std::uint8_t> bytes;
};
struct PinnedSnapshot {
    std::uint32_t version=0;
    std::vector<PinnedFile> files; // immutable via shared_ptr<const Snapshot>
};
// In production provide the existing native Rust sha2 verifier via
// fw_native_sha256_bytes. The portable tests inject a deterministic fake to
// isolate the file/manifest transaction; Rust SHA-256 has separate vectors.
using DigestFn=bool (*)(const std::uint8_t*,std::size_t,
                        std::uint8_t*,std::size_t);

inline bool validPinnedRelativePath(const std::string& path) noexcept {
    if(path.empty()||path.size()>4096||path.front()=='/'||
       path.back()=='/'||path.find('\\')!=std::string::npos)return false;
    // Restrict this initial contract to portable ASCII file names. Non-ASCII
    // may be supported in a later version with explicit Unicode normalization.
    for(unsigned char c:path)
        if(c<33||c>126||c==':'||c=='?'||c=='*'||c=='"'||
           c=='<'||c=='>'||c=='|'||c=='#')return false;
    std::size_t start=0;
    while(start<path.size()){
        const auto end=path.find('/',start);
        const auto length=(end==std::string::npos?path.size():end)-start;
        if(length==0)return false;
        const auto part=path.substr(start,length);
        if(part=="."||part==".."||part.front()=='.'||
           part.back()==' '||part.back()=='.')return false;
        if(end==std::string::npos)break;
        start=end+1;
    }
    return true;
}
inline std::string casefoldAscii(std::string value) {
    for(char& c:value)if(c>='A'&&c<='Z')
        c=static_cast<char>(c-'A'+'a');
    return value;
}
inline bool stagePinnedCandidate(const fs::path& root,
                                  const TrustedManifest& manifest,
                                  DigestFn digest,
                                  std::shared_ptr<const PinnedSnapshot>& output) noexcept {
    if(!digest||manifest.version!=1||manifest.files.empty()||
       manifest.files.size()>kMaxFiles)return false;
    try {
        Candidate checked{};
        if(!inspectCandidate(root,checked) ||
           checked.files!=manifest.files.size())return false;
        std::set<std::string> names;
        PinnedSnapshot staged{};
        staged.version=manifest.version;
        staged.files.reserve(manifest.files.size());
        std::uintmax_t total=0;
        bool index=false,bridge=false;
        for(const auto& expected:manifest.files){
            if(!validPinnedRelativePath(expected.path))return false;
            const auto name=casefoldAscii(expected.path);
            if(!names.insert(name).second)return false;
            const fs::path relative(expected.path);
            if(relative.is_absolute()||relative.has_root_name()||
               relative.lexically_normal().generic_string()!=expected.path||
               !allowedExtension(relative))return false;
            if(expected.bytes>kMaxFileBytes||
               total>kMaxTotalBytes-expected.bytes)return false;
            total+=expected.bytes;
            if(expected.path=="index.html"){
                if(expected.bytes==0)return false;
                index=true;
            }
            if(expected.path=="host-bridge.mjs"){
                if(expected.bytes==0)return false;
                bridge=true;
            }
            auto current=root;
            for(const auto& part:relative){
                current/=part;
                const auto type=fs::symlink_status(current);
                if(fs::is_symlink(type))return false;
            }
            if(!fs::is_regular_file(current)||
               fs::file_size(current)!=expected.bytes)return false;
            std::ifstream stream(current,std::ios::binary);
            if(!stream)return false;
            std::vector<std::uint8_t> bytes(static_cast<std::size_t>(expected.bytes));
            if(!bytes.empty()){
                stream.read(reinterpret_cast<char*>(bytes.data()),
                            static_cast<std::streamsize>(bytes.size()));
                if(!stream||stream.gcount()!=
                   static_cast<std::streamsize>(bytes.size()))return false;
            }
            // A grown file must not be silently truncated after inspection.
            if(stream.peek()!=std::char_traits<char>::eof())return false;
            std::array<std::uint8_t,32> actual{};
            if(!digest(bytes.data(),bytes.size(),actual.data(),actual.size())||
               actual!=expected.sha256)return false;
            staged.files.push_back(PinnedFile{expected.path,std::move(bytes)});
        }
        if(!index||!bridge)return false;
        // Output changes only after all files, names and hashes are valid.
        // Previously verified files never alias the mutable source directory.
        output=std::make_shared<const PinnedSnapshot>(std::move(staged));
        return true;
    }catch(...){return false;}
}
} // namespace fw::ui_assets
