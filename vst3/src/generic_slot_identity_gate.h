#pragma once
// R3B1: necessary, NOT sufficient, fixed generic host-slot preflight.
// This predicate does not parse or authenticate JSON descriptors and MUST NOT
// alone enable VST3 DAW automation. R3B2 must verify descriptor provenance,
// dimensional units, physical ranges and module semantic ABI. R3C owns the
// real-time-safe host/sample-offset DSP event path.
#include "project_binding_association.h"
#include <cstdint>
namespace fw {
inline bool matchesSavedGenericSlotCapability(
    const EngineProjectState& project,
    const VerifiedProjectEngine& engine,
    const SlotBindingIdentity& descriptorBinding,
    std::uint64_t verifiedWasmGenericMask) {
    if(!engine.active ||
       !binding_detail::legal(descriptorBinding) ||
       !matchSavedBindingToVerifiedEngine(project,engine))
        return false;
    const std::uint32_t slot=descriptorBinding.hostSlot;
    if(slot<64||slot>127||
       (verifiedWasmGenericMask & (std::uint64_t{1}<<(slot-64)))==0)
        return false;
    SlotBindingLedger saved;
    if(!decodeBindingLedger(project.bindingLedger.data(),
                            project.bindingLedger.size(),saved))return false;
    // The active engine, saved DAW project, and independently preflighted
    // descriptor candidate must agree on slot+engine+semantic+codec+hash.
    if(descriptorBinding.engineId!=engine.engineId ||
       descriptorBinding.packageSha256!=engine.sha256)return false;
    return slotAuthorizedBySavedIdentity(saved,descriptorBinding);
}
} // namespace fw
