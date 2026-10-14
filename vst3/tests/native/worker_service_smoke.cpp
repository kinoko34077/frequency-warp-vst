#include "../../src/native_worker_service.h"
#include <array>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <fstream>
#include <iostream>
#include <iterator>
#include <stdexcept>
#include <thread>
#include <vector>
static void ensure(bool ok,const char* why) {
    if(!ok)throw std::runtime_error(why);
}
static std::vector<std::uint8_t> read(const char* path) {
    std::ifstream in(path,std::ios::binary);
    ensure(in.good(),"file read failed");
    return {std::istreambuf_iterator<char>(in),std::istreambuf_iterator<char>()};
}
template<class Pred> static bool waitUntil(Pred pred) {
    const auto deadline=std::chrono::steady_clock::now()+std::chrono::seconds(5);
    while(!pred()){
        if(std::chrono::steady_clock::now()>deadline)return false;
        std::this_thread::sleep_for(std::chrono::milliseconds(1));
    }
    return true;
}
static void proveWet(fw::NativeWorkerService& svc,float level,std::uint64_t due) {
    std::array<float,128> left{},right{};
    left.fill(.8f);right.fill(.8f);
    const float* inputs[]={left.data(),right.data()};
    ensure(svc.mailbox().rtSubmit(inputs,2,128),"audio PCM was not submitted");
    // Test clock deliberately pauses before the playback deadline; the
    // worker has up to fixed-4095-sample PDC to execute real native WASM.
    std::this_thread::sleep_for(std::chrono::milliseconds(70));
    float wet[2]{};
    ensure(!svc.mailbox().rtReadWet(due-1,2,wet),"early wet leaked");
    for(std::uint64_t t=due;t<due+128;t++){
        ensure(svc.mailbox().rtReadWet(t,2,wet),"wet missing at expected deadline");
        ensure(std::abs(wet[0]-level)<1.e-5f&&std::abs(wet[1]-level)<1.e-5f,
               "wrong native WASM PCM from configured module");
    }
}
int main(int argc,char** argv) {
    try {
        ensure(argc==3,"need Identity.fwengine GainHalf.fwengine");
        auto a=read(argv[1]),b=read(argv[2]);
        fw::NativeWorkerService service;
        ensure(!service.mailbox().rtHasPreparedWorker(),"no module initially");
        ensure(service.start(),"worker failed to start");
        ensure(service.postPackage(a,48000.,2,128),"unable to request Identity");
        ensure(waitUntil([&]{return service.acceptedVersion()==1;}),
               "Identity was not prepared by worker");
        ensure(service.status()==fw::NativeWorkerService::Status::Ready,
               "native worker did not publish ready status");
        proveWet(service,.8f,4095);

        // Valid package replacement only, no rebuilding native C ABI.
        ensure(service.postPackage(b,48000.,2,128),"unable to request Gain");
        ensure(waitUntil([&]{return service.acceptedVersion()==2;}),
               "Gain was not accepted");
        proveWet(service,.4f,4095+128);

        const auto prior=service.acceptedVersion();
        ensure(service.postPackage(std::vector<uint8_t>{'b','a','d'},48000.,2,128),
               "invalid fixture must reach verifier");
        ensure(waitUntil([&]{return service.status()!=fw::NativeWorkerService::Status::Preparing;}),
               "worker stuck preparing invalid package");
        std::this_thread::sleep_for(std::chrono::milliseconds(70));
        ensure(service.acceptedVersion()==prior,"rejected module replaced valid module");
        proveWet(service,.4f,4095+256);

        service.stop();
        ensure(service.status()==fw::NativeWorkerService::Status::Stopped,
               "worker failed to stop");
        ensure(!service.mailbox().rtHasPreparedWorker(),
               "stopped plugin retained live worker pointer");
        ensure(service.mailbox().rtNextTime()==0,
               "stopped plugin retained stale source timeline");
        ensure(service.start(),"worker restart failed");
        ensure(service.postPackage(a,48000.,2,128),"restart package refused");
        ensure(waitUntil([&]{return service.acceptedVersion()==prior+1;}),
               "restarted worker failed to prepare fresh instance");
        proveWet(service,.8f,4095);
        service.stop();
        std::cout<<"PASS native worker: 2-module file replacement, rejection rollback, PDC, stop/restart\n";
        return 0;
    }catch(const std::exception& err){
        std::cerr<<"FAIL native worker: "<<err.what()<<"\n";return 1;
    }
}
