#include "../src/slot_binding_identity.h"
#include "../src/engine_project_state.h"
#include <algorithm>
#include <cstdio>
#include <cstdlib>
#include <stdexcept>
#include <vector>

static void require(bool ok,const char* why) {
    if(!ok){std::fprintf(stderr,"slot-binding-identity FAIL: %s\n",why);std::abort();}
}
static fw::SlotBindingIdentity binding(
    std::uint32_t slot=64,const char* semantic="gain",std::uint8_t sha=0x17) {
    fw::SlotBindingIdentity out{};
    out.hostSlot=slot;
    out.codecRevision=1;
    out.engineId="org.kinotch.gain";
    out.semanticId=semantic;
    out.packageSha256.fill(sha);
    return out;
}
int main() {
    using namespace fw;
    SlotBindingLedger base{{binding(64,"gain"),binding(65,"cutoff")}};
    require(validBindingLedger(base),"two named engine-scoped generic bindings");
    const auto bytes=encodeBindingLedger(base);
    SlotBindingLedger recovered;
    require(decodeBindingLedger(bytes.data(),bytes.size(),recovered),
            "decode canonical binding ledger");
    require(recovered.bindings.size()==2 &&
            recovered.bindings[0]==base.bindings[0] &&
            recovered.bindings[1]==base.bindings[1],"exact semantic identity");
    SlotBindingLedger outOfOrder{{base.bindings[1],base.bindings[0]}};
    require(encodeBindingLedger(outOfOrder)==bytes,"deterministic slot sorting");
    require(slotAuthorizedBySavedIdentity(recovered,binding()),"accepted same binding");
    require(!slotAuthorizedBySavedIdentity(recovered,binding(64,"unrelated")),
            "old Gain automation never binds to different meaning");
    require(!slotAuthorizedBySavedIdentity(recovered,binding(64,"gain",0x18)),
            "same semantic name but different package bytes needs review");
    auto changed=binding();changed.engineId="org.example.other";
    require(!slotAuthorizedBySavedIdentity(recovered,changed),
            "another engine cannot reuse same slot");
    changed=binding();changed.codecRevision=2;
    require(!slotAuthorizedBySavedIdentity(recovered,changed),
            "incompatible codec revision blocked");
    require(!slotAuthorizedBySavedIdentity(SlotBindingLedger{},binding()),
            "old project missing identity may not activate generic automation");

    SlotBindingLedger backup{{binding(75,"original")}};
    for(size_t n=0;n<bytes.size();++n) {
        require(!decodeBindingLedger(bytes.data(),n,backup),
                "all truncations rejected without state mutation");
        require(backup.bindings.size()==1 &&
                backup.bindings[0].semanticId=="original","decode is atomic");
    }
    auto bad=bytes;bad[19]^=0xffu;
    require(!decodeBindingLedger(bad.data(),bad.size(),backup),"corrupt crc rejected");
    bad=bytes;bad.push_back(0);
    require(!decodeBindingLedger(bad.data(),bad.size(),backup),"appended bytes rejected");
    require(!decodeBindingLedger(nullptr,0,backup),"null bytes rejected");
    require(!decodeBindingLedger(bytes.data(),size_t(-1),backup),
            "unbounded length fails before pointer arithmetic");
    SlotBindingLedger dup{{binding(),binding()}};
    require(!validBindingLedger(dup),"duplicated slot rejected");
    dup.bindings[1]=binding(65,"gain");
    require(!validBindingLedger(dup),"duplicated semantic meaning rejected");
    auto reserved=binding(34);
    require(!binding_detail::legal(reserved),"shell-reserved host slot rejected");
    auto beyond=binding(128);
    require(!binding_detail::legal(beyond),"host slot beyond 127 rejected");
    auto badCode=binding();badCode.codecRevision=0;
    require(!binding_detail::legal(badCode),"zero codec disallowed");
    auto badName=binding();badName.semanticId="../injection";
    require(!binding_detail::legal(badName),"unsafe semantic path rejected");
    bool threw=false;
    try{encodeBindingLedger(SlotBindingLedger{{reserved}});}
    catch(const std::invalid_argument&){threw=true;}
    require(threw,"invalid slot cannot be serialized");
    SlotBindingLedger maxLedger;
    for(unsigned i=0;i<64;++i)
        maxLedger.bindings.push_back(binding(64+i,("gain_"+std::to_string(i)).c_str()));
    require(validBindingLedger(maxLedger),"64 generic slots allowed");
    const auto maxBytes=encodeBindingLedger(maxLedger);
    SlotBindingLedger checked;
    require(decodeBindingLedger(maxBytes.data(),maxBytes.size(),checked) &&
            checked.bindings.size()==64,"64-slot roundtrip");
    maxLedger.bindings.push_back(binding(127,"overflow"));
    require(!validBindingLedger(maxLedger),"65th binding rejected");

    // Existing project codec stays unchanged. This new identity ledger is
    // an independent R2A candidate, not yet silently appended to FWS2.
    EngineProjectState legacy{};
    legacy.values.fill(.5);
    legacy.package={0,1,2,3};
    const auto projectBytes=encodeEngineProjectState(legacy);
    require(state_detail::get32(projectBytes.data(),4)==EngineProjectState::kV2,
            "legacy accepted FWS2 schema remains unchanged");
    EngineProjectState stateResult;
    require(decodeEngineProjectState(projectBytes.data(),projectBytes.size(),stateResult) &&
            stateResult.values[64]==.5 && stateResult.package==legacy.package,
            "existing embedded project archive still roundtrips");
    std::puts("R2A verified generic slot identity ledger and legacy FWS2 PASS");
}
