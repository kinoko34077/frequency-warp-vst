// Real native C++ -> Rust staticlib SHA-256 ABI regression (non-RT only).
#include "../src/native_engine_abi.h"
#include "../src/ui_asset_snapshot.h"
#include <array>
#include <chrono>
#include <filesystem>
#include <fstream>
#include <stdexcept>
#include <string>
#include <cstdio>
namespace fs=std::filesystem;
using namespace fw::ui_assets;
static void check(bool yes,const char* why){if(!yes)throw std::runtime_error(why);}
static bool realDigest(const std::uint8_t* bytes,std::size_t n,
                       std::uint8_t* result,std::size_t cap) {
    return fw_native_sha256_bytes(bytes,n,result,cap);
}
static ExpectedFile expect(const std::string& path,const std::string& data) {
    ExpectedFile file{};
    file.path=path;file.bytes=data.size();
    check(realDigest(reinterpret_cast<const std::uint8_t*>(data.data()),
                     data.size(),file.sha256.data(),file.sha256.size()),
          "real Rust SHA-256 FFI failed");
    return file;
}
static void write(const fs::path& path,const std::string& bytes){
    std::ofstream output(path,std::ios::binary|std::ios::trunc);
    check(static_cast<bool>(output),"file open failed");
    output.write(bytes.data(),static_cast<std::streamsize>(bytes.size()));
    check(static_cast<bool>(output),"write failed");
}
int main(){
    try {
        const std::string abc="abc";
        const std::array<std::uint8_t,32> expected={{
            0xba,0x78,0x16,0xbf,0x8f,0x01,0xcf,0xea,
            0x41,0x41,0x40,0xde,0x5d,0xae,0x22,0x23,
            0xb0,0x03,0x61,0xa3,0x96,0x17,0x7a,0x9c,
            0xb4,0x10,0xff,0x61,0xf2,0x00,0x15,0xad
        }};
        std::array<std::uint8_t,32> actual{};
        check(realDigest(reinterpret_cast<const std::uint8_t*>(abc.data()),
                         abc.size(),actual.data(),actual.size()),
              "native ABI call failed");
        check(actual==expected,"C++ to Rust SHA-256 golden vector mismatch");
        const auto root=fs::temp_directory_path()/(
            "fw-ui-digest-cpp-"+std::to_string(
            std::chrono::steady_clock::now().time_since_epoch().count()));
        struct Remove {
            fs::path root;
            ~Remove(){std::error_code ec;fs::remove_all(root,ec);}
        } cleanup{root};
        fs::create_directories(root);
        write(root/"index.html",abc);
        write(root/"host-bridge.mjs","export const x=1;");
        TrustedManifest manifest{1,{
            expect("index.html",abc),
            expect("host-bridge.mjs","export const x=1;")
        }};
        std::shared_ptr<const PinnedSnapshot> pinned;
        check(stagePinnedCandidate(root,manifest,realDigest,pinned),
              "real SHA-256 stage failed");
        check(pinned && pinned->files.size()==2,"pinning failed");
        const auto prior=pinned;
        write(root/"index.html","bad");
        check(!stagePinnedCandidate(root,manifest,realDigest,pinned),
              "changed bytes incorrectly accepted");
        check(pinned==prior,"failed stage overwrote last good shared snapshot");
        std::puts("UI-5B1 C++ <-> Rust digest ABI and staging PASS");
        return 0;
    }catch(const std::exception& err){
        std::fprintf(stderr,"UI5B1 native SHA FAIL: %s\n",err.what());
        return 1;
    }
}
