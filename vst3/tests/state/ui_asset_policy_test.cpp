#include "../../src/ui_asset_policy.h"
#include <chrono>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <stdexcept>
#include <string>
namespace fs=std::filesystem;
static void need(bool v,const char* msg){if(!v)throw std::runtime_error(msg);}
static void write(const fs::path& p,const char* bytes) {
    std::ofstream f(p,std::ios::binary);
    need(f.good(),"could not open test fixture");
    f<<bytes;
    need(f.good(),"could not write test fixture");
}
int main(){
    const auto path=fs::temp_directory_path()/
        ("fw-vst3-ui-policy-"+std::to_string(
          std::chrono::steady_clock::now().time_since_epoch().count()));
    struct Cleanup {
        fs::path p;
        ~Cleanup(){std::error_code ec;fs::remove_all(p,ec);}
    } cleanup{path};
    try {
        fs::create_directories(path);
        fw::ui_assets::Candidate out{};
        out.files=123;out.bytes=456;
        need(!fw::ui_assets::inspectCandidate(path,out),"missing index accepted");
        need(out.files==123&&out.bytes==456,"failure mutated caller state");
        write(path/"index.html","<!doctype html><title>UI</title>");
        write(path/"host-bridge.mjs","export const bridge=true;");
        need(fw::ui_assets::inspectCandidate(path,out),"safe local candidate rejected");
        need(out.files==2&&out.bytes>0&&out.hasIndex,"candidate report invalid");
        const auto prior=out;
        write(path/"evil.exe","unauthorized");
        need(!fw::ui_assets::inspectCandidate(path,out),"native executable accepted");
        need(out.files==prior.files&&out.bytes==prior.bytes,
             "rejected candidate mutated previously accepted report");
        fs::remove(path/"evil.exe");
        fs::resize_file(path/"host-bridge.mjs",
                        fw::ui_assets::kMaxFileBytes+1);
        need(!fw::ui_assets::inspectCandidate(path,out),"oversized asset accepted");
        fs::remove(path/"host-bridge.mjs");
        write(path/"host-bridge.mjs","export const ok=true;");
        std::error_code ec;
        fs::create_symlink(path.parent_path(),path/"escape",ec);
        if(!ec) {
            need(!fw::ui_assets::inspectCandidate(path,out),"symlink escape accepted");
            fs::remove(path/"escape");
        }
        need(fw::ui_assets::inspectCandidate(path,out),
             "safe asset root not restored after bad candidate");
        fs::remove(path/"index.html");
        need(!fw::ui_assets::inspectCandidate(path,out),"removed index accepted");
        std::cout<<"UI-5A PASS local asset size/type/root checks with atomic deny\n";
    }catch(const std::exception& e) {
        std::cerr<<"UI-5A FAIL: "<<e.what()<<'\n';return 1;
    }
}
