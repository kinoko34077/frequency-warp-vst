#pragma once
// D8A: non-RT authoritative GUI mask from the already saved FWS3 project,
// verified worker package identity and a currently live authorization ticket.
// Local HTML/JS or a WASM declaration alone NEVER enables a VST3 host edit.
#include "project_binding_association.h"
#include <cstdint>

namespace fw {
inline std::uint64_t verifiedGenericUiMask(
    const EngineProjectState& project,
    const VerifiedProjectEngine& worker,
    std::uint64_t liveTicket) noexcept {
    if(liveTicket==0||!worker.active||worker.acceptedGeneration==0||
       worker.package.empty()||project.bindingLedger.empty())return 0;
    try {
        // Saved FWS3 decode and identity matching may allocate; malformed
        // or oversized project bytes MUST fail closed, never terminate DAW.
        if(!matchSavedBindingToVerifiedEngine(project,worker))return 0;
        SlotBindingLedger ledger{};
        if(!decodeBindingLedger(project.bindingLedger.data(),
                                project.bindingLedger.size(),ledger)||
           ledger.bindings.empty()||!validBindingLedger(ledger))
            return 0;
        std::uint64_t mask=0;
        for(const auto& b:ledger.bindings){
            if(b.hostSlot<64||b.hostSlot>127||b.codecRevision!=1)return 0;
            const auto bit=std::uint64_t{1}<<(b.hostSlot-64);
            if(mask&bit)return 0;
            mask|=bit;
        }
        return mask;
    } catch(...) {return 0;}
}
} // namespace fw
