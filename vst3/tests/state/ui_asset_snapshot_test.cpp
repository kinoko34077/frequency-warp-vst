#include "../../src/ui_asset_snapshot.h"
#include <chrono>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <stdexcept>
#include <string>
namespace fs=std::filesystem;
using namespace fw::ui_assets;
static void need(bool yes,const char* why){if(!yes)throw std::runtime_error(why);}
static void write(const fs::path& p,const std::string& bytes){
    fs::create_directories(p.parent_path());
    std::ofstream out(p,std::ios::binary|std::ios::trunc);
    out.write(bytes.data(),static_cast<std::streamsize>(bytes.size()));
    need(static_cast<bool>(out),"write fixture failed");
}
// TEST-ONLY deterministic fake: exercises pinning transaction, not SHA256.
static bool fakeDigest(const std::uint8_t* data,std::size_t size,
                       std::uint8_t* out,std::size_t cap){
    if(!out||cap!=32)return false;
    std::uint8_t h=0;
    for(std::size_t i=0;i<size;i++)h=static_cast<std::uint8_t>((h*33)^data[i]);
    for(std::size_t i=0;i<32;i++)out[i]=static_cast<std::uint8_t>(h+i);
    return true;
}
static bool rejectDigest(const std::uint8_t*,std::size_t,
                         std::uint8_t*,std::size_t){return false;}
static ExpectedFile expected(const std::string& path,const std::string& data){
    ExpectedFile f{};
    f.path=path;f.bytes=data.size();
    need(fakeDigest(reinterpret_cast<const std::uint8_t*>(data.data()),
                    data.size(),f.sha256.data(),32),"fake digest");
    return f;
}
int main(){
    const auto root=fs::temp_directory_path()/
        ("fw-ui5b1-"+std::to_string(
           std::chrono::steady_clock::now().time_since_epoch().count()));
    struct Clean {fs::path p;~Clean(){std::error_code ec;fs::remove_all(p,ec);}} clean{root};
    try {
        const std::string html="<!doctype html><title>Pinned</title>";
        const std::string js="export const protocol='v1';";
        const std::string css="body{color:white}";
        write(root/"index.html",html);
        write(root/"host-bridge.mjs",js);
        write(root/"asset"/"theme.css",css);
        TrustedManifest trusted{1,{expected("index.html",html),
                                   expected("host-bridge.mjs",js),
                                   expected("asset/theme.css",css)}};
        std::shared_ptr<const PinnedSnapshot> accepted;
        need(stagePinnedCandidate(root,trusted,fakeDigest,accepted),
             "known manifest does not stage");
        need(accepted->version==1&&accepted->files.size()==3,"incorrect pinned snapshot");
        need(std::string(accepted->files[0].bytes.begin(),
                         accepted->files[0].bytes.end())==html,"pinned content differs");
        const auto pinnedHtml=accepted->files[0].bytes;
        write(root/"index.html",html+" CHANGED");
        need(!stagePinnedCandidate(root,trusted,fakeDigest,accepted),
             "post-manifest mutation accepted");
        need(accepted->files[0].bytes==pinnedHtml,"failure destroyed last-good snapshot");
        write(root/"index.html",html);
        TrustedManifest bad=trusted;
        bad.files[0].sha256[0]^=1;
        need(!stagePinnedCandidate(root,bad,fakeDigest,accepted),"wrong hash accepted");
        bad=trusted;bad.version=2;
        need(!stagePinnedCandidate(root,bad,fakeDigest,accepted),"unknown version accepted");
        bad=trusted;bad.files[0].bytes++;
        need(!stagePinnedCandidate(root,bad,fakeDigest,accepted),"wrong size accepted");
        bad=trusted;bad.files[1].path="../host-bridge.mjs";
        need(!stagePinnedCandidate(root,bad,fakeDigest,accepted),"escape path accepted");
        bad=trusted;bad.files[1].path="C:/host-bridge.mjs";
        need(!stagePinnedCandidate(root,bad,fakeDigest,accepted),"drive path accepted");
        bad=trusted;bad.files[1].path="INDEX.html";
        need(!stagePinnedCandidate(root,bad,fakeDigest,accepted),"casefold alias accepted");
        bad=trusted;bad.files.erase(bad.files.begin()+1);
        need(!stagePinnedCandidate(root,bad,fakeDigest,accepted),"missing bridge accepted");
        need(!stagePinnedCandidate(root,trusted,rejectDigest,accepted),
             "digest failure accepted");
        need(!stagePinnedCandidate(root,trusted,nullptr,accepted),
             "no hash provider accepted");
        write(root/"extra.css","unlisted");
        need(!stagePinnedCandidate(root,trusted,fakeDigest,accepted),
             "unlisted local file accepted");
        fs::remove(root/"extra.css");
        std::error_code ec;
        fs::create_symlink(root/"index.html",root/"asset"/"shortcut.css",ec);
        if(!ec) {
            need(!stagePinnedCandidate(root,trusted,fakeDigest,accepted),
                 "symlink candidate accepted");
            fs::remove(root/"asset"/"shortcut.css");
        }
        need(stagePinnedCandidate(root,trusted,fakeDigest,accepted),
             "legitimate candidate not recoverable after failures");
        need(accepted->files[0].bytes==pinnedHtml,
             "recovery changed prior approved bytes");
        std::cout<<"UI-5B1 candidate pinning and transactional rollback PASS\n";
    }catch(const std::exception& e) {
        std::cerr<<"UI-5B1 FAIL: "<<e.what()<<'\n';return 1;
    }
}
