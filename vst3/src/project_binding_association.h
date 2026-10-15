#pragma once
// R2C3A: pure non-RT association between the exact saved FWS3 package,
// its engine-scoped semantic ledger, and a worker-confirmed module identity.
// IMPORTANT: a matching hash is byte identity, NOT code signing, nor an
// authorization for new generic DSP parameters. R3 must separately negotiate
// actual WASM semantic capabilities before routing any ID64..127 events.
#include "engine_project_state.h"
#include <algorithm>
#include <array>
#include <cstdint>
#include <string>
#include <vector>
namespace fw {
struct VerifiedProjectEngine {
    std::vector<std::uint8_t> package; // exact last worker-confirmed bytes
    std::string engineId;
    std::array<std::uint8_t,32> sha256{};
    std::uint64_t acceptedGeneration=0;
    bool active=false; // informational only; stop may retain accepted bytes
};
inline bool matchSavedBindingToVerifiedEngine(
    const EngineProjectState& image,const VerifiedProjectEngine& worker) {
    if(image.bindingLedger.empty() || image.package.empty() ||
       worker.package.empty() || worker.acceptedGeneration==0 ||
       worker.engineId.empty() || image.package!=worker.package)return false;
    SlotBindingLedger candidate;
    if(!decodeBindingLedger(image.bindingLedger.data(),
                            image.bindingLedger.size(),candidate) ||
       candidate.bindings.empty() || !validBindingLedger(candidate))return false;
    for(const auto& binding:candidate.bindings) {
        if(binding.engineId!=worker.engineId ||
           binding.packageSha256!=worker.sha256)return false;
    }
    return true;
}
} // namespace fw
