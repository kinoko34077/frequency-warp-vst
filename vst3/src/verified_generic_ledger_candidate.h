#pragma once
// R3C2D3: construct ONLY a candidate saved-FWS3 slot->semantic ledger.
// The source of each semantic and numeric codec MUST be the SAME live,
// worker-verified WASM handle after whole-descriptor native attestation.
// This pure non-RT helper does not update project state or grant DAW/RT edits.
#include "project_binding_association.h"
#include "generic_numeric_codec.h"
#include "native_engine_abi.h"
#include <array>
#include <cstdint>
#include <string>
#include <utility>
#include <vector>

namespace fw {
template<class ReadSemantic,class ReadCodec>
bool buildVerifiedGenericLedgerCandidate(
    const VerifiedProjectEngine& verified,std::uint64_t attestedMask,
    ReadSemantic&& readSemantic,ReadCodec&& readCodec,
    SlotBindingLedger& out) {
    if(!verified.active || verified.acceptedGeneration==0 ||
       verified.engineId.empty() || verified.package.empty() ||
       verified.package.size()>EngineProjectState::kMaxPackage ||
       attestedMask==0)return false;
    SlotBindingLedger pending{};
    try {
        for(std::uint32_t bit=0;bit<64;++bit) {
            if(!(attestedMask&(std::uint64_t{1}<<bit)))continue;
            const std::uint32_t slot=64+bit;
            std::string semantic;
            FWNativeGenericCodec native{};
            if(!readSemantic(slot,semantic) ||
               !readCodec(slot,native) ||
               native.hostSlot!=slot ||
               native.codecRevision!=1 || native.scale>4)
                return false;
            GenericNumericCodec numeric{};
            numeric.hostSlot=native.hostSlot;
            numeric.codecRevision=native.codecRevision;
            numeric.scale=static_cast<GenericScale>(native.scale);
            numeric.steps=native.steps;
            numeric.min=native.min;
            numeric.max=native.max;
            numeric.def=native.defaultValue;
            if(!validGenericNumericCodec(numeric))return false;
            SlotBindingIdentity binding{};
            binding.hostSlot=slot;
            binding.codecRevision=native.codecRevision;
            binding.engineId=verified.engineId;
            binding.semanticId=std::move(semantic);
            binding.packageSha256=verified.sha256;
            pending.bindings.push_back(std::move(binding));
        }
        if(pending.bindings.empty() || !validBindingLedger(pending))return false;
    }catch(...) {return false;}
    out=std::move(pending);
    return true;
}
} // namespace fw
