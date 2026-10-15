#include "../../src/native_worker_service.h"
#include "../../src/slot_binding_identity.h"
#include "../../src/explicit_generic_ledger_commit_gate.h"
#include <array>
#include <chrono>
#include <cstdint>
#include <cmath>
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
        // Worker-side evidence only, before any authorization ticket exists.
        need(worker.postPrepareNewLedger(doc,850),"queue nonRT candidate");
        need(until([&]{return (worker.lastPreparedLedgerWord()>>1)==850;}),
             "candidate acknowledgement");
        need((worker.lastPreparedLedgerWord()&1)!=0,"live WASM candidate denied");
        fw::NativeWorkerService::PreparedNewLedger prepared{};
        need(worker.readPreparedNewLedger(850,prepared),"candidate unavailable");
        fw::SlotBindingLedger candidateLedger{};
        need(fw::decodeBindingLedger(prepared.encodedLedger.data(),
                 prepared.encodedLedger.size(),candidateLedger) &&
             candidateLedger.bindings.size()==1 &&
             candidateLedger.bindings[0].hostSlot==64 &&
             candidateLedger.bindings[0].semanticId=="gain" &&
             prepared.packageSha256==accepted.packageSha256 &&
             prepared.acceptedGeneration==accepted.acceptedGeneration,
             "candidate not tied to live WASM engine");
        need(prepared.stagedAuthorization.ticket==0 &&
             prepared.stagedAuthorization.allowedMask==1 &&
             prepared.stagedAuthorization.acceptedGeneration==
                 accepted.acceptedGeneration &&
             prepared.stagedAuthorization.verifiedPackageSha256==
                 accepted.packageSha256 &&
             prepared.stagedAuthorization.codec[0].hostSlot==64 &&
             prepared.stagedAuthorization.codec[0].min==0. &&
             prepared.stagedAuthorization.codec[0].max==4.,
             "D7A escrow must contain same-live-WASM numeric evidence, no ticket");
        need(worker.genericAuthorization().workerCurrentTicket()==0,
             "candidate must not authorize DAW audio");
        need(!worker.postCommitPreparedNewLedger(850,false),
             "new binding cannot commit without explicit request");
        need(!worker.postCommitPreparedNewLedger(851,true),
             "incorrect request cannot commit a candidate");
        need(worker.postCommitPreparedNewLedger(850,true),
             "request explicit same-worker commit");
        need(until([&]{return (worker.lastCommittedLedgerWord()>>1)==850;}),
             "worker commit completion missing");
        need((worker.lastCommittedLedgerWord()&1)!=0,
             "worker did not commit valid candidate");
        fw::NativeWorkerService::PreparedNewLedger committed{};
        need(worker.readCommittedNewLedger(committed) &&
             committed.requestId==850 && committed.authorizedTicket!=0 &&
             committed.stagedAuthorization.allowedMask==1 &&
             committed.encodedLedger==prepared.encodedLedger &&
             committed.packageSha256==accepted.packageSha256,
             "atomic worker commit differs from live engine proof");
        fw::GenericNewLedgerEvidence evidence{};
        evidence.requestId=committed.requestId;
        evidence.authorizedTicket=committed.authorizedTicket;
        evidence.acceptedGeneration=committed.acceptedGeneration;
        evidence.packageSha256=committed.packageSha256;
        evidence.authorizedMask=committed.stagedAuthorization.allowedMask;
        evidence.encodedLedger=committed.encodedLedger;
        fw::VerifiedProjectEngine current{};
        current.active=true;
        current.package=accepted.package;
        current.engineId=accepted.engineId;
        current.sha256=accepted.packageSha256;
        current.acceptedGeneration=accepted.acceptedGeneration;
        std::vector<std::uint8_t> selected{};
        need(fw::selectExplicitNewLedgerForCommit(
                evidence,current,850,worker.genericAuthorization().workerCurrentTicket(),
                1,{},true,selected) && selected==committed.encodedLedger,
             "Processor D5 exact project commit gate rejects worker authority");
        const auto exactSelected=selected;
        // Real project persistence contract: an accepted new Worker-ledger
        // must serialize as FWS3 with exact package/semantic identity, and
        // re-open without silently interpreting the same slot differently.
        fw::EngineProjectState savedProject=project;
        savedProject.bindingLedger=exactSelected;
        const auto serialized=fw::encodeEngineProjectState(savedProject);
        fw::EngineProjectState reopened{};
        need(serialized.size()>12 && serialized[4]==3 &&
             fw::decodeEngineProjectState(
                 serialized.data(),serialized.size(),reopened) &&
             reopened.package==gain &&
             reopened.bindingLedger==exactSelected &&
             fw::matchSavedBindingToVerifiedEngine(reopened,current),
             "new FWS3 project cannot roundtrip with verified Gain identity");
        auto changed=current;
        changed.sha256[0]^=1;
        need(!fw::matchSavedBindingToVerifiedEngine(reopened,changed),
             "saved Gain automation aliased a different package identity");
        need(!fw::selectExplicitNewLedgerForCommit(
                evidence,current,851,committed.authorizedTicket,1,{},true,selected) &&
             selected==exactSelected,"wrong request mutated previously selected ledger");
        need(!fw::selectExplicitNewLedgerForCommit(
                evidence,current,850,committed.authorizedTicket,1,exactSelected,true,selected),
             "silent migration of an existing FWS3 binding accepted");
        auto& firstRT=worker.genericAuthorization();
        firstRT.rtAdopt();
        need(firstRT.rtAllows(64,accepted.acceptedGeneration,accepted.packageSha256),
             "committed ticket was not visible to the RT mailbox");
        need(!worker.postCommitPreparedNewLedger(850,true),
             "second implicit commit/migration must be denied");
        need(worker.postAuthorization(project,doc,902),"request real WASM proof");
        need(!worker.readCommittedNewLedger(committed) &&
             !firstRT.rtAllows(64,accepted.acceptedGeneration,accepted.packageSha256),
             "new command failed to revoke prior committed binding and ticket");
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
        // Real native WASM Gain is now driven by an authorization-tagged
        // canonical slot64 packet; old external host slot aliases stay inert.
        const auto* live=rt.rtLiveSnapshot();
        need(live && live->ticket!=0,"RT authorized immutable snapshot");
        fw::AsyncPcmMailbox::AuthorizationTag tag{};
        tag.ticket=live->ticket;
        tag.acceptedGeneration=live->acceptedGeneration;
        tag.packageSha256=live->verifiedPackageSha256;
        std::array<float,128> left{},right{};
        left.fill(.8f);right.fill(.8f);
        const float* audio[]={left.data(),right.data()};
        const FWNativeEvent gainEvent{64,0,.25}; // Gain = .25, .8 * .25 = .2
        need(worker.mailbox().rtSubmit(audio,2,128,&gainEvent,1,&tag),
             "tagged Gain packet accepted");
        float wet[2]{};
        fw::AsyncPcmMailbox::AuthorizationTag returned{};
        need(until([&]{return worker.mailbox().rtReadWet(4095,2,wet,&returned);}),
             "real worker tagged PCM returned");
        need(std::abs(wet[0]-.2f)<1e-5f &&
             std::abs(wet[1]-.2f)<1e-5f &&
             returned.ticket==tag.ticket &&
             rt.rtTicketLive(returned.ticket),
             "incorrect tagged Gain/identity/PCM");
        for(std::uint64_t t=4096;t<4223;t++)
            need(worker.mailbox().rtReadWet(t,2,wet,&returned),
                 "tagged chunk wet continuity");
        // A stale/tag-forged packet cannot invoke Wasmi or become audible.
        const auto failuresBefore=worker.mailbox().stats().workerFailures;
        auto stale=tag;
        stale.ticket^=0x100;
        need(worker.mailbox().rtSubmit(audio,2,128,&gainEvent,1,&stale),
             "tagged stale packet accepted to worker rejection path");
        need(until([&]{return worker.mailbox().stats().workerFailures>failuresBefore;}),
             "worker did not detect stale ticket");
        need(!worker.mailbox().rtReadWet(4223,2,wet,&returned),
             "stale packet emitted audible unauthorized wet");
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
