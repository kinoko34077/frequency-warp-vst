#include "../../src/native_worker_service.h"
#include "../../src/slot_binding_identity.h"
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

static void need(bool ok,const char* message) {
    if(!ok)throw std::runtime_error(message);
}
static std::vector<std::uint8_t> read(const char* path) {
    std::ifstream file(path,std::ios::binary);
    need(file.good(),"fixture missing");
    return {std::istreambuf_iterator<char>(file),std::istreambuf_iterator<char>()};
}
template<class Pred> static bool until(Pred pred) {
    const auto end=std::chrono::steady_clock::now()+std::chrono::seconds(8);
    while(!pred()){
        if(std::chrono::steady_clock::now()>=end)return false;
        std::this_thread::sleep_for(std::chrono::milliseconds(1));
    }
    return true;
}
static std::string hex(const std::array<std::uint8_t,32>& value) {
    static constexpr char digit[]="0123456789abcdef";
    std::string result;
    for(const auto b:value){result.push_back(digit[b>>4]);result.push_back(digit[b&15]);}
    return result;
}
static std::vector<std::uint8_t> descriptor(
       const std::array<std::uint8_t,32>& hash) {
    const auto doc=std::string(R"({"schema":"frequency-warp-ui-descriptors-v1","engine":{"id":"org.kinotch.gainhalf","version":"0.1.0","sha256":")")+
        hex(hash)+R"("},"bindings":[{"host_slot":64,"semantic_id":"gain","label":"Gain","dimension":"signedRatio","canonical_unit":"ratio","min":0,"max":4,"default":0.5,"scale":"linear","widget":"knob","display_units":["ratio"],"codec_revision":1,"snap":{"values":[0,0.5,1],"radius_normalized":0.03}}]})";
    return {doc.begin(),doc.end()};
}
int main(int argc,char** argv) {
    try {
        need(argc==3,"usage: worker_authorization_test Identity.fwengine Gain.fwengine");
        auto identity=read(argv[1]),gain=read(argv[2]);
        fw::NativeWorkerService worker;
        need(worker.start(),"start");
        need(worker.postPackage(gain,48000.,2,128,901),"enqueue Gain");
        need(until([&]{return worker.lastCompletedId()==901 &&
                       worker.lastCompletedSucceeded();}),"Gain activation");
        const auto accepted=worker.verifiedIdentitySnapshot();
        need(accepted.active&&accepted.engineId=="org.kinotch.gainhalf",
             "verified Gain source");
        fw::SlotBindingLedger ledger{};
        ledger.bindings.push_back({64,1,accepted.engineId,"gain",accepted.packageSha256});
        fw::EngineProjectState project{};
        project.values.fill(.5);
        project.package=gain;
        project.bindingLedger=fw::encodeBindingLedger(ledger);
        auto doc=descriptor(accepted.packageSha256);
        need(worker.postAuthorization(project,doc,902),"request real WASM proof");
        need(until([&]{return (worker.lastAuthorizationWord()>>1)==902;}),
             "authorization completion");
        need((worker.lastAuthorizationWord()&1)!=0,
             "worker rejected exact FWS3/WASM numeric contract");
        auto& rt=worker.genericAuthorization();
        need(!rt.rtAllows(64,accepted.acceptedGeneration,accepted.packageSha256),
             "RT cannot access unpublished bytes");
        rt.rtAdopt();
        need(rt.rtAllows(64,accepted.acceptedGeneration,accepted.packageSha256),
             "live worker epoch granted slot64");
        const auto* codec=rt.rtCodec(64,accepted.acceptedGeneration,accepted.packageSha256);
        need(codec && codec->hostSlot==64 && codec->min==0. &&
             codec->max==4. && codec->defaultValue==0.5,
             "native numeric contract not copied intact");
        need(!rt.rtAllows(65,accepted.acceptedGeneration,accepted.packageSha256),
             "unverified generic slot leaked");
        auto wrong=project;
        wrong.bindingLedger.back()^=0x80;
        need(worker.postAuthorization(wrong,doc,903),"enqueue invalid FWS3");
        need(!rt.rtAllows(64,accepted.acceptedGeneration,accepted.packageSha256),
             "request revokes before worker acknowledgement");
        need(until([&]{return (worker.lastAuthorizationWord()>>1)==903;}),
             "rejected binding acknowledgement");
        need((worker.lastAuthorizationWord()&1)==0,
             "tampered FWS3 ledger accepted");
        rt.rtAdopt();
        need(!rt.rtAllows(64,accepted.acceptedGeneration,accepted.packageSha256),
             "stale packet reauthorized after denial");
        need(worker.postAuthorization(project,doc,904),"re-authorization");
        need(until([&]{return (worker.lastAuthorizationWord()>>1)==904;}),
             "authorization retry completion");
        need((worker.lastAuthorizationWord()&1)!=0,"retry must pass");
        rt.rtAdopt();
        need(rt.rtAllows(64,accepted.acceptedGeneration,accepted.packageSha256),
             "retry publication must become active");
        // Race audit: enqueue a fresh authorization, then race a replacement
        // against its worker-side preflight/commit. Once the GUI replacement
        // is accepted, no late old-generation publication may re-enable Gain.
        need(worker.postAuthorization(project,doc,907),
             "enqueue overlapping authorization proof");
        bool replacementQueued=false;
        const auto untilReplacement=std::chrono::steady_clock::now()+
                                    std::chrono::seconds(8);
        while(!replacementQueued) {
            replacementQueued=worker.postPackage(identity,48000.,2,128,905);
            if(replacementQueued)break;
            need(std::chrono::steady_clock::now()<untilReplacement,
                 "replacement remained pending too long");
            std::this_thread::sleep_for(std::chrono::milliseconds(1));
        }
        need(!rt.rtAllows(64,accepted.acceptedGeneration,accepted.packageSha256),
             "queued replacement failed to revoke old generic binding");
        need(until([&]{return worker.lastCompletedId()==905 &&
                       worker.lastCompletedSucceeded();}),"identity replacement");
        rt.rtAdopt();
        const auto replaced=worker.verifiedIdentitySnapshot();
        need(replaced.packageSha256!=accepted.packageSha256,
             "replacement identity unchanged");
        need(!rt.rtAllows(64,accepted.acceptedGeneration,accepted.packageSha256),
             "stale Gain binding active after replacement");
        need(worker.postAuthorization(project,doc,906),"try old project on Identity");
        need(until([&]{return (worker.lastAuthorizationWord()>>1)==906;}),
             "old binding attempt finished");
        need((worker.lastAuthorizationWord()&1)==0,"foreign engine authorized");
        worker.stop();
        need(!rt.rtAllows(64,accepted.acceptedGeneration,accepted.packageSha256),
             "stop cannot retain permission");
        std::cout<<"R3C2C1 PASS: real Gain WASM/FWS3 epoch authorization and worker revoke\n";
    }catch(const std::exception& ex){
        std::cerr<<"R3C2C1 FAIL: "<<ex.what()<<'\n';return 1;
    }
}
