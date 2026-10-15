#pragma once
// R3C2A: build a *candidate* non-RT authorization mask from a saved FWS3
// semantic ledger + immutable worker-confirmed engine + WASM-owned descriptor.
// This is NOT yet published to RT or exposed to the DAW/WebView controller.
// R3C2B/C/D must independently gate automation, audio and UI use.
#include "generic_slot_identity_gate.h"
#include <array>
#include <cstddef>
#include <cstdint>
#include <utility>
#include <vector>
namespace fw {
struct GenericAuthorizationPlan {
    std::uint64_t allowedMask=0; // bit0 == fixed VST3 ParamID64
    std::uint64_t acceptedGeneration=0;
    std::array<std::uint8_t,32> verifiedPackageSha256{};
    bool allows(std::uint32_t hostSlot,std::uint64_t currentGeneration,
                const std::array<std::uint8_t,32>& currentSha) const noexcept {
        return hostSlot>=64 && hostSlot<=127 &&
            acceptedGeneration!=0 &&
            acceptedGeneration==currentGeneration &&
            verifiedPackageSha256==currentSha &&
            (allowedMask&(std::uint64_t{1}<<(hostSlot-64)))!=0;
    }
};
// Descriptor JSON is external UI data, NEVER an authority. The provided
// preflight callback MUST call fw_native_preflight_generic_descriptor on the
// exact still-live verified Wasmi handle (off the audio thread) and attest
// the module-authored semantic/dimensional/numeric contract. A hash is byte
// identity, not a publisher signature. Reject the entire plan on any error.
template<class NativePreflight>
GenericAuthorizationPlan buildGenericAuthorizationPlan(
    const EngineProjectState& project,const VerifiedProjectEngine& worker,
    std::uint64_t wasmDeclaredMask,
    const std::vector<std::uint8_t>& externalDescriptorJson,
    NativePreflight&& nativePreflight) {
    GenericAuthorizationPlan denied{};
    if(!worker.active || worker.acceptedGeneration==0 ||
       project.bindingLedger.empty() || externalDescriptorJson.empty() ||
       externalDescriptorJson.size()>65536 ||
       !matchSavedBindingToVerifiedEngine(project,worker))
        return denied;
    SlotBindingLedger saved{};
    if(!decodeBindingLedger(project.bindingLedger.data(),
                            project.bindingLedger.size(),saved) ||
       saved.bindings.empty() || !validBindingLedger(saved))
        return denied;
    std::uint64_t acceptedMask=0;
    for(const auto& item:saved.bindings) {
        if(!matchesSavedGenericSlotCapability(project,worker,item,
                                              wasmDeclaredMask))
            return denied;
        // No half-authorized mask survives a failing or throwing descriptor
        // preflight. Native callback is invoked only on the non-RT worker.
        bool attested=false;
        try {attested=nativePreflight(item,externalDescriptorJson);}
        catch(...) {return denied;}
        if(!attested)return denied;
        const std::uint64_t bit=std::uint64_t{1}<<(item.hostSlot-64);
        if(acceptedMask&bit)return denied;
        acceptedMask|=bit;
    }
    return GenericAuthorizationPlan{acceptedMask,worker.acceptedGeneration,
                                    worker.sha256};
}
} // namespace fw
