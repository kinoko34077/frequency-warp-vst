#pragma once
// R3C2D5: pure, non-RT FINAL-PERSISTENCE PRECONDITION for explicitly creating
// a new FWS3 ledger. It is not the worker transport, an atomic commit,
// or permission to enable DAW generic host automation.
// The caller must obtain evidence and live ticket/mask from the SAME
// worker-owned, already attested Wasmi generation. The eventual persistence
// transaction MUST fence worker revocation/swap while rechecking this guard.
#include "project_binding_association.h"
#include <array>
#include <cstdint>
#include <limits>
#include <vector>

namespace fw {
struct GenericNewLedgerEvidence {
    std::uint64_t requestId=0;
    std::uint64_t authorizedTicket=0;
    std::uint64_t acceptedGeneration=0;
    std::array<std::uint8_t,32> packageSha256{};
    std::uint64_t authorizedMask=0;
    std::vector<std::uint8_t> encodedLedger{};
};
// Failures never overwrite a previously chosen ledger. Existing project
// mappings are preserved by default: migration is a SEPARATE explicit flow.
inline bool selectExplicitNewLedgerForCommit(
    const GenericNewLedgerEvidence& proof,
    const VerifiedProjectEngine& current,
    std::uint64_t expectedRequest,std::uint64_t liveTicket,
    std::uint64_t liveMask,
    const std::vector<std::uint8_t>& existingSavedLedger,
    bool explicitlyRequested,
    std::vector<std::uint8_t>& output) {
    if(!explicitlyRequested||!existingSavedLedger.empty()||
       !current.active||current.package.empty()||
       current.acceptedGeneration==0||
       expectedRequest==0||
       expectedRequest>static_cast<std::uint64_t>(
           std::numeric_limits<std::int64_t>::max())||
       proof.requestId!=expectedRequest ||
       proof.authorizedTicket==0||proof.authorizedTicket!=liveTicket||
       proof.acceptedGeneration!=current.acceptedGeneration ||
       proof.packageSha256!=current.sha256 ||
       proof.authorizedMask==0||proof.authorizedMask!=liveMask||
       proof.encodedLedger.empty()||
       proof.encodedLedger.size()>EngineProjectState::kMaxLedger)
        return false;
    SlotBindingLedger decoded{};
    if(!decodeBindingLedger(proof.encodedLedger.data(),
                            proof.encodedLedger.size(),decoded) ||
       decoded.bindings.empty())return false;
    std::uint64_t exactSlots=0;
    for(const auto& item:decoded.bindings) {
        if(item.hostSlot<64||item.hostSlot>127||
           item.codecRevision!=1)return false; // fixed current RT codec
        const auto bit=std::uint64_t{1}<<(item.hostSlot-64);
        if(exactSlots&bit)return false;
        exactSlots|=bit;
    }
    if(exactSlots!=proof.authorizedMask)return false;
    EngineProjectState candidate{};
    candidate.package=current.package;
    candidate.bindingLedger=proof.encodedLedger;
    if(!matchSavedBindingToVerifiedEngine(candidate,current))return false;
    output=candidate.bindingLedger;
    return true;
}
} // namespace fw
