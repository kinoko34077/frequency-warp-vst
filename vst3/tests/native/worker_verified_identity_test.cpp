#include "../../src/native_worker_service.h"
#include <algorithm>
#include <array>
#include <chrono>
#include <cstdint>
#include <fstream>
#include <iostream>
#include <iterator>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>

static void check(bool ok,const char* what) {
    if(!ok) throw std::runtime_error(what);
}
static std::vector<uint8_t> load(const char* filename) {
    std::ifstream in(filename,std::ios::binary);
    check(in.good(),"engine fixture unreadable");
    return {std::istreambuf_iterator<char>(in),std::istreambuf_iterator<char>()};
}
template<class Predicate> static bool awaitCondition(Predicate condition) {
    const auto until=std::chrono::steady_clock::now()+std::chrono::seconds(8);
    while(!condition()){
        if(std::chrono::steady_clock::now()>=until)return false;
        std::this_thread::sleep_for(std::chrono::milliseconds(1));
    }
    return true;
}
int main(int argc,char** argv) {
    try {
        check(argc==3,"provide Identity and Gain .fwengine paths");
        const auto identity=load(argv[1]),gain=load(argv[2]);
        fw::NativeWorkerService worker;
        auto empty=worker.verifiedIdentitySnapshot();
        check(empty.package.empty() && empty.engineId.empty() &&
              empty.acceptedGeneration==0 && !empty.active,
              "cold worker invented identity");
        check(worker.start(),"cannot start worker");
        check(worker.postPackage(identity,48000.,2,128,601),"Identity enqueue");
        check(awaitCondition([&]{return worker.lastCompletedId()==601 &&
              worker.lastCompletedSucceeded() &&
              worker.status()==fw::NativeWorkerService::Status::Ready;}),
              "Identity prepare and activation");
        const auto a=worker.verifiedIdentitySnapshot();
        check(a.active&&a.acceptedGeneration==1 &&
              a.package==identity && a.engineId=="org.kinotch.identity" &&
              std::any_of(a.packageSha256.begin(),a.packageSha256.end(),
                 [](uint8_t x){return x!=0;}),"verified Identity metadata");
        // Verify against immutable identity independently obtained from the
        // real native prepared module, not a hard-coded fixture digest.
        auto* independently=fw_native_prepare(identity.data(),identity.size(),48000.,2,128);
        check(independently!=nullptr,"parallel independent identity prepare");
        std::array<uint8_t,32> exactHash{};
        std::array<uint8_t,129> exactName{};
        const auto nameLen=fw_native_copy_verified_identity(
            independently,exactHash.data(),exactHash.size(),
            exactName.data(),exactName.size());
        fw_native_destroy(independently);
        check(nameLen==a.engineId.size() &&
              std::string(reinterpret_cast<const char*>(exactName.data()),nameLen)==a.engineId &&
              exactHash==a.packageSha256,"same package must have exact byte identity");

        const auto before=worker.handledRequests();
        check(worker.postPackage({'b','a','d'},48000.,2,128,602),
              "malformed candidate must reach verifier");
        check(awaitCondition([&]{return worker.handledRequests()==before+1 &&
                   worker.lastCompletedId()==602;}),"rejected candidate complete");
        check(!worker.lastCompletedSucceeded(),"invalid candidate was accepted");
        const auto afterReject=worker.verifiedIdentitySnapshot();
        check(afterReject.active && afterReject.acceptedGeneration==1 &&
              afterReject.package==a.package &&
              afterReject.packageSha256==a.packageSha256 &&
              afterReject.engineId==a.engineId,
              "invalid candidate modified previously verified identity");

        check(worker.postPackage(gain,48000.,2,128,603),"Gain enqueue");
        check(awaitCondition([&]{return worker.lastCompletedId()==603 &&
                   worker.lastCompletedSucceeded() &&
                   worker.acceptedVersion()==2;}),"Gain prepare complete");
        const auto b=worker.verifiedIdentitySnapshot();
        check(b.active && b.acceptedGeneration==2 &&
              b.engineId=="org.kinotch.gainhalf" && b.package==gain &&
              b.packageSha256!=a.packageSha256,
              "successful swap did not advance coherent identity");
        // Preserve currently active identity if another independent instance
        // is started, and never let its record modify this instance.
        fw::NativeWorkerService other;
        check(other.start(),"second worker start");
        check(other.postPackage(identity,48000.,2,128,701),"second worker request");
        check(awaitCondition([&]{return other.lastCompletedId()==701 &&
                   other.lastCompletedSucceeded();}),"second worker verified");
        const auto isolated=other.verifiedIdentitySnapshot();
        check(isolated.active && isolated.acceptedGeneration==1 &&
              isolated.packageSha256==a.packageSha256 &&
              worker.verifiedIdentitySnapshot().packageSha256==b.packageSha256,
              "cross-instance identity leak");
        other.stop();

        worker.stop();
        const auto afterStop=worker.verifiedIdentitySnapshot();
        check(!afterStop.active && afterStop.acceptedGeneration==2 &&
              afterStop.package==gain &&
              afterStop.packageSha256==b.packageSha256,
              "stopped worker must preserve verified bytes but not active state");
        check(worker.start(),"restart worker");
        check(worker.postPackage(identity,48000.,2,128,604),"reprepare identity");
        check(awaitCondition([&]{return worker.lastCompletedId()==604 &&
                   worker.lastCompletedSucceeded() &&
                   worker.acceptedVersion()==3;}),"reprepare acknowledged");
        const auto restarted=worker.verifiedIdentitySnapshot();
        check(restarted.active&&restarted.acceptedGeneration==3 &&
              restarted.packageSha256==a.packageSha256 &&
              restarted.engineId==a.engineId,"reprepare generation mismatch");

        const auto beforeClear=worker.handledRequests();
        check(worker.postClear(605),"engine unload queued");
        check(awaitCondition([&]{return worker.handledRequests()==beforeClear+1 &&
                   worker.lastCompletedId()==605;}),"engine unload finished");
        check(worker.lastCompletedSucceeded(),"unload not acknowledged");
        const auto unloaded=worker.verifiedIdentitySnapshot();
        check(!unloaded.active&&unloaded.package.empty() &&
              unloaded.engineId.empty()&&unloaded.acceptedGeneration==0 &&
              std::all_of(unloaded.packageSha256.begin(),
                          unloaded.packageSha256.end(),
                          [](uint8_t x){return x==0;}),
              "cleared project retained foreign identity");
        worker.stop();
        check(worker.clearVerifiedWhenStopped(),"cold verified clear");
        check(worker.verifiedIdentitySnapshot().package.empty(),"cold clear bytes");

        std::cout<<"PASS R2C2 successful/rejected/swap/restart/unload and multi-instance verified identities\n";
    }catch(const std::exception& ex) {
        std::cerr<<"FAIL R2C2: "<<ex.what()<<"\n";
        return 1;
    }
    return 0;
}
