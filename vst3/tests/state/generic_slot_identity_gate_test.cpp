#include "../../src/generic_slot_identity_gate.h"
#include <cstdio>
#include <cstdlib>
static void expect(bool value,const char* why){
    if(!value){std::fprintf(stderr,"R3B1 generic gate FAIL: %s\n",why);std::abort();}
}
static fw::SlotBindingIdentity make(unsigned slot,const char* semantic) {
    fw::SlotBindingIdentity b{};
    b.hostSlot=slot;b.codecRevision=1;
    b.engineId="org.example.verified";
    b.semanticId=semantic;
    b.packageSha256.fill(0x5a);
    return b;
}
int main(){
    using namespace fw;
    const auto slot64=make(64,"gain"),slot127=make(127,"cutoff");
    EngineProjectState project{};
    project.values.fill(.5);
    project.package={0x50,0x4b,0x03,0x04,0x22,0x78};
    project.bindingLedger=encodeBindingLedger(SlotBindingLedger{{slot64,slot127}});
    const auto serialized=encodeEngineProjectState(project);
    EngineProjectState saved{};
    expect(decodeEngineProjectState(serialized.data(),serialized.size(),saved),
           "FWS3 image roundtrip");
    VerifiedProjectEngine worker{};
    worker.package=project.package;worker.engineId=slot64.engineId;
    worker.sha256=slot64.packageSha256;worker.acceptedGeneration=8;
    worker.active=true;
    expect(matchesSavedGenericSlotCapability(saved,worker,slot64,1ull),
           "verified worker + FWS3 + advertised slot64");
    expect(matchesSavedGenericSlotCapability(saved,worker,slot127,1ull<<63),
           "slot127 uses highest generic bit, not stream mask");
    expect(!matchesSavedGenericSlotCapability(saved,worker,slot64,0),
           "missing optional WASM export must revoke generic edits");
    expect(!matchesSavedGenericSlotCapability(saved,worker,slot127,1ull),
           "slot64 capability must not grant slot127");
    expect(!matchesSavedGenericSlotCapability(saved,worker,slot64,1ull<<63),
           "slot127 capability must not grant slot64");
    worker.active=false;
    expect(!matchesSavedGenericSlotCapability(saved,worker,slot64,1ull),
           "suspended worker can preserve ledger but cannot activate DAW edits");
    worker.active=true;worker.acceptedGeneration=0;
    expect(!matchesSavedGenericSlotCapability(saved,worker,slot64,1ull),
           "unconfirmed worker cannot grant permissions");
    worker.acceptedGeneration=8;
    auto wrong=slot64;wrong.semanticId="wrong";
    expect(!matchesSavedGenericSlotCapability(saved,worker,wrong,1ull),
           "semantic alias rejected");
    wrong=slot64;wrong.codecRevision=2;
    expect(!matchesSavedGenericSlotCapability(saved,worker,wrong,1ull),
           "codec migration cannot happen implicitly");
    wrong=slot64;wrong.packageSha256[0]^=0x01;
    expect(!matchesSavedGenericSlotCapability(saved,worker,wrong,1ull),
           "descriptor different content hash blocked");
    wrong=slot64;wrong.engineId="org.example.other";
    expect(!matchesSavedGenericSlotCapability(saved,worker,wrong,1ull),
           "another engine cannot repurpose old host automation");
    worker.engineId="org.example.other";
    expect(!matchesSavedGenericSlotCapability(saved,worker,slot64,1ull),
           "worker swapped to different engine");
    worker.engineId=slot64.engineId;
    worker.package.push_back(0);
    expect(!matchesSavedGenericSlotCapability(saved,worker,slot64,1ull),
           "different archive bytes with same claimed hash blocked");
    worker.package=project.package;
    EngineProjectState legacy=project;legacy.bindingLedger.clear();
    expect(!matchesSavedGenericSlotCapability(legacy,worker,slot64,1ull),
           "old FWS2 has no implicit generic meaning");
    auto corrupt=project;corrupt.bindingLedger.back()^=1;
    expect(!matchesSavedGenericSlotCapability(corrupt,worker,slot64,1ull),
           "tampered project ledger rejected");
    wrong=slot64;wrong.hostSlot=33;
    expect(!matchesSavedGenericSlotCapability(project,worker,wrong,~0ull),
           "native reserved/legacy host slots cannot be repurposed");
    std::puts("PASS R3B1: generic capability + exact saved semantic ID + verified worker");
}
