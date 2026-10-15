#include "../../src/generic_authorization_plan.h"
#include <algorithm>
#include <array>
#include <cstdio>
#include <cstdlib>
#include <string>
#include <stdexcept>
#include <vector>
static void require(bool ok,const char* message) {
    if(!ok){std::fprintf(stderr,"R3C2A plan FAIL: %s\n",message);std::abort();}
}
static fw::SlotBindingIdentity make(unsigned id,const char* semantic) {
    fw::SlotBindingIdentity result{};
    result.hostSlot=id;result.codecRevision=1;
    result.engineId="org.example.verified";
    result.semanticId=semantic;result.packageSha256.fill(0x57);
    return result;
}
int main() {
    using namespace fw;
    const auto first=make(64,"gain"),last=make(127,"mix");
    EngineProjectState state{};
    state.values.fill(.5);
    state.package={0x50,0x4b,0x03,0x04,0xaa,0xbb};
    state.bindingLedger=encodeBindingLedger(SlotBindingLedger{{last,first}});
    VerifiedProjectEngine worker{};
    worker.package=state.package;worker.engineId=first.engineId;
    worker.sha256=first.packageSha256;
    worker.acceptedGeneration=10;worker.active=true;
    const std::vector<std::uint8_t> external={'{','}','\n'};
    unsigned callbacks=0;
    const auto preflight=[&](const SlotBindingIdentity& binding,
                             const std::vector<std::uint8_t>& descriptor){
        ++callbacks;
        return descriptor==external &&
            ((binding.hostSlot==64&&binding.semanticId=="gain")||
             (binding.hostSlot==127&&binding.semanticId=="mix")) &&
            binding.codecRevision==1;
    };
    const auto both=buildGenericAuthorizationPlan(state,worker,
        (1ull|1ull<<63),external,preflight);
    require(callbacks==2 && both.allowedMask==(1ull|1ull<<63),
            "two attested saved slot meanings");
    require(both.allows(64,10,worker.sha256)&&
            both.allows(127,10,worker.sha256),
            "only verified generation/identity are enabled");
    require(!both.allows(65,10,worker.sha256) &&
            !both.allows(33,10,worker.sha256) &&
            !both.allows(128,10,worker.sha256),
            "reserved, absent and out-of-range slots rejected");
    require(!both.allows(64,11,worker.sha256),
            "new generation revokes old authorization");
    auto newHash=worker.sha256;newHash[0]^=1;
    require(!both.allows(64,10,newHash),"new package revokes old authorization");
    require(!both.allows(64,0,worker.sha256),"never authorize cold worker");
    const auto deniedMask=buildGenericAuthorizationPlan(state,worker,1,
        external,preflight);
    require(deniedMask.allowedMask==0 && deniedMask.acceptedGeneration==0,
            "missing declared bit must reject entire plan");
    const auto notAttested=buildGenericAuthorizationPlan(state,worker,
        (1ull|1ull<<63),external,
        [&](const auto& item,const auto&){return item.hostSlot==64;});
    require(notAttested.allowedMask==0,"one mismatched WASM contract rejects entire plan");
    const auto thrown=buildGenericAuthorizationPlan(state,worker,
        (1ull|1ull<<63),external,
        [](const auto&,const auto&)->bool{
            throw std::runtime_error("module attestation failed");
        });
    require(thrown.allowedMask==0 && thrown.acceptedGeneration==0,
            "attestation exception cannot partially grant permissions");
    require(buildGenericAuthorizationPlan(state,worker,~0ull,{},
        preflight).allowedMask==0,"missing descriptor does not grant permissions");
    require(buildGenericAuthorizationPlan(state,worker,~0ull,
        std::vector<std::uint8_t>(65537,'x'),preflight).allowedMask==0,
        "oversized UI descriptor is rejected");
    worker.active=false;
    require(buildGenericAuthorizationPlan(state,worker,~0ull,
        external,preflight).allowedMask==0,"stopped worker may not authorize");
    worker.active=true;worker.acceptedGeneration=0;
    require(buildGenericAuthorizationPlan(state,worker,~0ull,
        external,preflight).allowedMask==0,"pending worker not authoritative");
    worker.acceptedGeneration=10;
    worker.engineId="org.example.other";
    require(buildGenericAuthorizationPlan(state,worker,~0ull,
        external,preflight).allowedMask==0,"swapped engine cannot hijack old slots");
    worker.engineId=first.engineId;worker.package.push_back(0);
    require(buildGenericAuthorizationPlan(state,worker,~0ull,
        external,preflight).allowedMask==0,"different WASM package bytes fail");
    worker.package=state.package;worker.sha256[0]^=1;
    require(buildGenericAuthorizationPlan(state,worker,~0ull,
        external,preflight).allowedMask==0,"new package hash fails");
    worker.sha256=first.packageSha256;
    auto old=state;old.bindingLedger.clear();
    require(buildGenericAuthorizationPlan(old,worker,~0ull,
        external,preflight).allowedMask==0,"legacy FWS2 has no active generic rights");
    auto damaged=state;damaged.bindingLedger.back()^=1;
    require(buildGenericAuthorizationPlan(damaged,worker,~0ull,
        external,preflight).allowedMask==0,"corrupt ledger cannot grant a slot");
    auto different=state;
    SlotBindingLedger ledger{{first,make(127,"hijack")}};
    different.bindingLedger=encodeBindingLedger(ledger);
    require(buildGenericAuthorizationPlan(different,worker,~0ull,
        external,preflight).allowedMask==0,
        "different semantic ID fails native WASM descriptor callback");
    // This snapshot is inert until R3C2B/C/D non-RT publish and RT consumption.
    std::puts("PASS R3C2A: saved identity, WASM preflight, worker epoch and no alias");
}
