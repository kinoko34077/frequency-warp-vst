#include "../../src/native_engine_abi.h"
#include <cmath>
#include <cstdint>
#include <fstream>
#include <iostream>
#include <iterator>
#include <stdexcept>
#include <vector>
static std::vector<std::uint8_t> load(const char* name) {
    std::ifstream file(name, std::ios::binary);
    if (!file) throw std::runtime_error("cannot read engine package");
    return std::vector<std::uint8_t>(
        std::istreambuf_iterator<char>(file),std::istreambuf_iterator<char>());
}
static void check(bool ok, const char* what){
    if(!ok)throw std::runtime_error(what);
}
int main(int argc,char** argv){
    try{
        check(argc==3,"provide Identity.fwengine Gain.fwengine");
        auto a=load(argv[1]), b=load(argv[2]);
        auto* identity=fw_native_prepare(a.data(),a.size(),48000.,2,256);
        auto* half=fw_native_prepare(b.data(),b.size(),48000.,2,256);
        check(identity&&half,"native C ABI engine preparation failed");
        check(fw_native_latency(identity)==0,"manifest latency mismatch");
        std::vector<float> in(512,0.8f),outA(512,0.f),outB(512,0.f);
        check(fw_native_process(identity,in.data(),outA.data(),256,nullptr,0)==0,
            "native C ABI identity process failed");
        check(fw_native_process(half,in.data(),outB.data(),256,nullptr,0)==0,
            "native C ABI gain process failed");
        for(std::size_t i=0;i<in.size();++i){
            check(std::abs(outA[i]-0.8f)<1e-5f,"identity PCM mismatch");
            check(std::abs(outB[i]-0.4f)<1e-5f,"gain PCM mismatch");
        }
        FWNativeEvent change{64,128,0.25};
        check(fw_native_process(half,in.data(),outB.data(),256,&change,1)==0,
            "native C ABI automation process failed");
        check(std::abs(outB[0]-0.4f)<1e-5f &&
            std::abs(outB[128]-0.2f)<1e-5f,"sample-accurate C ABI automation incorrect");
        check(fw_native_process(half,in.data(),in.data(),256,nullptr,0)!=0,
            "alias guard incorrectly accepted in-place buffers");
        check(!fw_native_faulted(identity),"normal identity engine faulted");
        fw_native_destroy(identity);
        fw_native_destroy(half);
        check(fw_native_prepare(reinterpret_cast<const std::uint8_t*>("bad"),
            3,48000.,2,256)==nullptr,"bad module unexpectedly created an engine");
        std::cout<<"PASS native C++ host <-> Rust WASM staticlib: real PCM file swap, automation, alias guard\n";
        return 0;
    }catch(const std::exception& e){
        std::cerr<<"FAIL: "<<e.what()<<"\n";return 1;
    }
}
