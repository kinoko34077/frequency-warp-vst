#include "../../src/native_engine_abi.h"
#include "../../src/async_pcm_mailbox.h"
#include <array>
#include <thread>
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
        check(fw_native_abi_major()==1u,"native C ABI version incompatible");
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
        // S3b3: the exact SAME fixed worker callback accepts either package.
        // Actual wasmi executes on a separate thread, never on simulated RT.
        auto* asyncIdentity=fw_native_prepare(a.data(),a.size(),48000.,2,128);
        auto* asyncGain=fw_native_prepare(b.data(),b.size(),48000.,2,128);
        check(asyncIdentity&&asyncGain,"async module prepare rejected valid packages");
        auto workerCallback=+[](void* context,const float* input,float* output,
                                std::uint32_t frames,const FWNativeEvent* events,
                                std::uint32_t n)->std::int32_t{
            return fw_native_process(static_cast<FWNativeOpaque*>(context),
                                     input,output,frames,events,n);
        };
        fw::AsyncPcmMailbox mailbox;
        std::array<float,128> left{},right{};
        left.fill(.8f);right.fill(.8f);
        const float* planar[]={left.data(),right.data()};
        check(mailbox.workerConfigure(workerCallback,asyncIdentity,
              fw_native_latency(asyncIdentity)),"async prepare Identity");
        check(mailbox.rtSubmit(planar,2,128),"audio thread queues Identity");
        std::thread firstWorker([&]{
            check(mailbox.workerStep(),"Identity PCM processed on worker");
        });
        firstWorker.join();
        float wet[2]{};
        for(std::uint64_t t=0;t<4095;t++){
            check(!mailbox.rtReadWet(t,2,wet),"premature native wet before PDC");
        }
        for(std::uint64_t t=4095;t<4095+128;t++){
            check(mailbox.rtReadWet(t,2,wet),"deadline-aligned native Identity wet");
            check(std::abs(wet[0]-.8f)<1e-5f&&std::abs(wet[1]-.8f)<1e-5f,
                  "native Identity PCM changed via async queue");
        }
        check(mailbox.workerConfigure(workerCallback,asyncGain,
              fw_native_latency(asyncGain)),"async prepare Gain");
        FWNativeEvent asyncEvent{64,64,.25};
        check(mailbox.rtSubmit(planar,2,128,&asyncEvent,1),
              "audio thread queues Gain with sample-offset parameter");
        std::thread secondWorker([&]{
            check(mailbox.workerStep(),"Gain PCM processed on worker");
        });
        secondWorker.join();
        for(std::uint64_t t=4223;t<4223+128;t++){
            check(mailbox.rtReadWet(t,2,wet),"deadline-aligned native Gain wet");
            const float gain=t-4223<64?.5f:.25f;
            check(std::abs(wet[0]-.8f*gain)<1e-5f&&
                  std::abs(wet[1]-.8f*gain)<1e-5f,
                  "real file-only module exchange and per-sample automation");
        }
        fw_native_destroy(asyncIdentity);
        fw_native_destroy(asyncGain);
        check(fw_native_prepare(reinterpret_cast<const std::uint8_t*>("bad"),
            3,48000.,2,256)==nullptr,"bad module unexpectedly created an engine");
        std::cout<<"PASS native C++/Rust WASM and asynchronous worker PCM: PDC 4095, file swap, automation, alias guard\n";
        return 0;
    }catch(const std::exception& e){
        std::cerr<<"FAIL: "<<e.what()<<"\n";return 1;
    }
}
