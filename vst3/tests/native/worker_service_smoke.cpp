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
static void proveWet(fw::NativeWorkerService& svc,float level,std::uint64_t due,
                    bool unboundHostAutomation=false) {
    std::array<float,128> left{},right{};
    left.fill(.8f);right.fill(.8f);
    const float* inputs[]={left.data(),right.data()};
    // Host may automate core Stream IDs2..5 while a demo Gain/Identity is
    // loaded. The worker must filter these UNBOUND parameters, not fault.
    FWNativeEvent event{4,64,0.75};
    ensure(svc.mailbox().rtSubmit(inputs,2,128,
          unboundHostAutomation?&event:nullptr,unboundHostAutomation?1:0),
          "audio PCM was not submitted");
    // Test clock deliberately pauses before the playback deadline; the
    // worker has up to fixed-4095-sample PDC to execute real native WASM.
    float wet[2]{};
    ensure(!svc.mailbox().rtReadWet(due-1,2,wet),"early wet leaked");
    ensure(waitUntil([&]{return svc.mailbox().rtReadWet(due,2,wet);}),
           "worker did not return wet before simulated deadline");
    ensure(std::abs(wet[0]-level)<1.e-5f&&std::abs(wet[1]-level)<1.e-5f,
           "first PCM sample mismatch");
    for(std::uint64_t t=due+1;t<due+128;t++){
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
        ensure(service.postPackage(a,48000.,2,128,17),"unable to request Identity");
        ensure(waitUntil([&]{return service.acceptedVersion()==1&&
            service.status()==fw::NativeWorkerService::Status::Ready&&
            service.lastCompletedId()==17;}),
               "Identity was not prepared by worker");
        ensure(service.lastCompletedId()==17&&service.lastCompletedSucceeded(),
               "verified Identity request outcome not correlated");
        proveWet(service,.8f,4095,true);

        // Valid package replacement only, no rebuilding native C ABI.
        ensure(service.postPackage(b,48000.,2,128,18),"unable to request Gain");
        ensure(waitUntil([&]{return service.acceptedVersion()==2&&service.lastCompletedId()==18;}),
               "Gain was not accepted");
        ensure(service.lastCompletedId()==18&&service.lastCompletedSucceeded(),
               "verified Gain request outcome not correlated");
        proveWet(service,.4f,4095+128,true);

        const auto prior=service.acceptedVersion();
        const auto before=service.handledRequests();
        ensure(service.postPackage(std::vector<uint8_t>{'b','a','d'},48000.,2,128,19),
               "invalid fixture must reach verifier");
        ensure(waitUntil([&]{return service.handledRequests()==before+1;}),
               "worker did not finish rejecting invalid package");
        ensure(service.acceptedVersion()==prior,"rejected module replaced valid module");
        ensure(service.lastCompletedId()==19&&!service.lastCompletedSucceeded(),
               "rejected candidate reported as accepted or lost its request token");
        proveWet(service,.4f,4095+256);

        // Reject UNBOUND Stream ID4, but preserve the demo module's actual
        // Gain ID64 automation. Two events on one worker packet.
        std::array<float,128> proofLeft{},proofRight{};
        proofLeft.fill(.8f);proofRight.fill(.8f);
        const float* proofInputs[]={proofLeft.data(),proofRight.data()};
        FWNativeEvent mixed[]={{4,0,.75},{64,0,.25}};
        ensure(service.mailbox().rtSubmit(proofInputs,2,128,mixed,2),
               "worker mixed-semantic packet rejected");
        float filtered[2]{};
        ensure(waitUntil([&]{return service.mailbox().rtReadWet(4095+384,2,filtered);}),
               "Gain native WASM did not return filtered slot64 event");
        ensure(std::abs(filtered[0]-.2f)<1.e-5f &&
               std::abs(filtered[1]-.2f)<1.e-5f,
               "Gain ID64 was stripped or unbound ID4 caused a trap");
        for(std::uint64_t t=4095+385;t<4095+512;t++)
            ensure(service.mailbox().rtReadWet(t,2,filtered),
                   "filtered Gain block output missing");

        service.stop();
        ensure(service.status()==fw::NativeWorkerService::Status::Stopped,
               "worker failed to stop");
        ensure(!service.mailbox().rtHasPreparedWorker(),
               "stopped plugin retained live worker pointer");
        ensure(service.mailbox().rtNextTime()==0,
               "stopped plugin retained stale source timeline");
        ensure(service.start(),"worker restart failed");
        ensure(service.postPackage(a,48000.,2,128,20),"restart package refused");
        ensure(waitUntil([&]{return service.acceptedVersion()==prior+1&&service.lastCompletedId()==20;}),
               "restarted worker failed to prepare fresh instance");
        ensure(service.lastCompletedId()==20&&service.lastCompletedSucceeded(),
               "restart request token was not acknowledged");
        proveWet(service,.8f,4095);
        service.stop();
        std::cout<<"PASS native worker: 2-module file replacement, rejection rollback, PDC, stop/restart\n";
        return 0;
    }catch(const std::exception& err){
        std::cerr<<"FAIL native worker: "<<err.what()<<"\n";return 1;
    }
}
