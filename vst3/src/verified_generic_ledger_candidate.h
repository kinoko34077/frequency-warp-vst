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
// Non-RT native-worker adapter for R3C2D4. The candidate is derived
// exclusively from the SAME live verified Wasmi instance: package identity,
// complete external descriptor preflight and canonical semantic/codec bytes.
// The resulting ledger is STILL NOT committed to a DAW project, and this
// function never publishes a permission ticket or alters audio processing.
// Callers must recheck generation/identity at the eventual commit boundary.
inline bool buildLiveWasmGenericLedgerCandidate(
    const FWNativeOpaque* live,const VerifiedProjectEngine& verified,
    const std::uint8_t* descriptor,std::size_t descriptorSize,
    SlotBindingLedger& output) {
    if(!live||!verified.active||verified.acceptedGeneration==0||
       verified.package.empty()||!descriptor||descriptorSize==0||
       descriptorSize>65536)return false;
    std::array<std::uint8_t,32> digest{};
    std::array<std::uint8_t,129> engine{};
    const auto nameLength=fw_native_copy_verified_identity(
        live,digest.data(),digest.size(),engine.data(),engine.size());
    if(nameLength==0||nameLength>128||
       digest!=verified.sha256 ||
       std::string(reinterpret_cast<const char*>(engine.data()),
                   nameLength)!=verified.engineId)return false;
    std::uint64_t selected=0;
    if(!fw_native_attest_generic_descriptor_set(
           live,descriptor,descriptorSize,&selected) || !selected)
        return false;
    return buildVerifiedGenericLedgerCandidate(
        verified,selected,
        [live](std::uint32_t slot,std::string& semantic){
            std::array<std::uint8_t,129> bytes{};
            const auto len=fw_native_copy_generic_semantic_id(
                live,slot,bytes.data(),bytes.size());
            if(len==0||len>128)return false;
            semantic.assign(reinterpret_cast<const char*>(bytes.data()),len);
            return true;
        },
        [live](std::uint32_t slot,FWNativeGenericCodec& codec){
            return fw_native_copy_generic_codec(live,slot,&codec);
        },output);
}
} // namespace fw
