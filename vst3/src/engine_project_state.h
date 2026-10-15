#pragma once
// S4c0: portable, non-RT project-state image codec. No SDK or Rust dependency.
// Image v1 is EXACTLY the historical S2 IBStreamer representation, so old
// saved projects still load; v2 adds a bounded self-contained engine package.
// No file paths, trusted "active" flag or native handles are serialized.
// CRC catches accidental state damage; it is NOT module authentication.
// Actual .fwengine security/manifest/SHA/ABI verification happens on S4c1
// worker before activation, never in the DAW audio callback.
#include <array>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <limits>
#include <stdexcept>
#include <utility>
#include <vector>
#include "slot_binding_identity.h"

namespace fw {
struct EngineProjectState {
    static constexpr std::uint32_t kMagic=0x46575332u;
    static constexpr std::uint32_t kV1=1,kV2=2,kV3=3,kCount=128;
    static constexpr std::size_t kMaxPackage=8u*1024u*1024u;
    static constexpr std::size_t kLegacySize=12u+8u*kCount;
    static constexpr std::size_t kMinV2Size=kLegacySize+8u;
    static constexpr std::size_t kMinV3Size=kLegacySize+12u;
    static constexpr std::size_t kMaxLedger=16u+64u*(4u+4u+1u+128u+1u+128u+32u);
    std::array<double,kCount> values{};
    std::vector<std::uint8_t> package{}; // exact worker-accepted archive bytes
    // Optional V3 semantic identity image; validated, NOT authorized here.
    // Active host changes and DAW getState/setState ownership are R2C/R3 gates.
    std::vector<std::uint8_t> bindingLedger{};
};
static_assert(sizeof(double)==8,"VST3 normalized values must use binary64");
namespace state_detail {
inline void push32(std::vector<std::uint8_t>& out,std::uint32_t value) {
    for(unsigned s=0;s<32;s+=8)
        out.push_back(static_cast<std::uint8_t>(value>>s));
}
inline void push64(std::vector<std::uint8_t>& out,std::uint64_t value) {
    for(unsigned s=0;s<64;s+=8)
        out.push_back(static_cast<std::uint8_t>(value>>s));
}
inline std::uint32_t get32(const std::uint8_t* bytes,std::size_t pos) {
    std::uint32_t v=0;
    for(unsigned i=0;i<4;i++)v|=std::uint32_t(bytes[pos+i])<<(8*i);
    return v;
}
inline std::uint64_t get64(const std::uint8_t* bytes,std::size_t pos) {
    std::uint64_t v=0;
    for(unsigned i=0;i<8;i++)v|=std::uint64_t(bytes[pos+i])<<(8*i);
    return v;
}
inline std::uint32_t crc32(const std::uint8_t* bytes,std::size_t n) {
    std::uint32_t crc=0xFFFFFFFFu;
    for(std::size_t i=0;i<n;i++){
        crc^=bytes[i];
        for(unsigned bit=0;bit<8;bit++)
            crc=(crc>>1)^((crc&1u)?0xEDB88320u:0u);
    }
    return crc^0xFFFFFFFFu;
}
}
inline std::vector<std::uint8_t> encodeEngineProjectState(
    const EngineProjectState& image) {
    if(image.package.size()>EngineProjectState::kMaxPackage)
        throw std::invalid_argument("project package exceeds 8 MiB");
    for(double v:image.values){
        if(!std::isfinite(v)||v<0.||v>1.)
            throw std::invalid_argument("non-normalized project parameter");
    }
    const bool v3=!image.bindingLedger.empty();
    if(v3) {
        if(image.package.empty() || image.bindingLedger.size()>EngineProjectState::kMaxLedger)
            throw std::invalid_argument("generic binding needs bounded verified engine package");
        SlotBindingLedger checked;
        if(!decodeBindingLedger(image.bindingLedger.data(),image.bindingLedger.size(),checked)||
           checked.bindings.empty())
            throw std::invalid_argument("invalid project semantic bindings");
    }
    std::vector<std::uint8_t> result;
    result.reserve((v3?EngineProjectState::kMinV3Size:EngineProjectState::kMinV2Size)+image.package.size()+image.bindingLedger.size());
    state_detail::push32(result,EngineProjectState::kMagic);
    state_detail::push32(result,v3?EngineProjectState::kV3:EngineProjectState::kV2);
    state_detail::push32(result,EngineProjectState::kCount);
    for(double value:image.values){
        std::uint64_t bits=0;
        std::memcpy(&bits,&value,8);
        state_detail::push64(result,bits);
    }
    state_detail::push32(result,static_cast<std::uint32_t>(image.package.size()));
    result.insert(result.end(),image.package.begin(),image.package.end());
    if(v3) {
        state_detail::push32(result,static_cast<std::uint32_t>(image.bindingLedger.size()));
        result.insert(result.end(),image.bindingLedger.begin(),image.bindingLedger.end());
    }
    state_detail::push32(result,state_detail::crc32(result.data(),result.size()));
    return result;
}
// Atomic: on false, destination including its previous verified package
// remains untouched. Unknown future schemas are not silently reinterpreted.
// On v1 success the old params are retained and package is explicitly empty.
inline bool decodeEngineProjectState(const std::uint8_t* bytes,std::size_t size,
                                    EngineProjectState& destination) {
    using S=EngineProjectState;
    if(!bytes||size<S::kLegacySize||
       size>S::kMinV3Size+S::kMaxPackage+S::kMaxLedger)return false;
    if(state_detail::get32(bytes,0)!=S::kMagic||
       state_detail::get32(bytes,8)!=S::kCount)return false;
    const auto schema=state_detail::get32(bytes,4);
    if(schema!=S::kV1&&schema!=S::kV2&&schema!=S::kV3)return false;
    if(schema==S::kV1&&size!=S::kLegacySize)return false;
    S pending;
    for(std::size_t i=0;i<S::kCount;i++){
        const auto bits=state_detail::get64(bytes,12+8*i);
        double v=0.;
        std::memcpy(&v,&bits,8);
        if(!std::isfinite(v)||v<0.||v>1.)return false;
        pending.values[i]=v;
    }
    if(schema==S::kV2||schema==S::kV3) {
        if(size<S::kMinV2Size)return false;
        const std::size_t packageLen=state_detail::get32(bytes,S::kLegacySize);
        if(packageLen>S::kMaxPackage)return false;
        const std::size_t afterPackage=S::kLegacySize+4u+packageLen;
        if(schema==S::kV2) {
            if(size!=S::kMinV2Size+packageLen)return false;
        } else {
            if(packageLen==0||size<afterPackage+8u)return false;
            const std::size_t bindingLen=state_detail::get32(bytes,afterPackage);
            if(bindingLen>S::kMaxLedger ||
               size!=S::kMinV3Size+packageLen+bindingLen)return false;
            SlotBindingLedger verifiedShape;
            const auto* ledgerBytes=bytes+afterPackage+4u;
            if(!decodeBindingLedger(ledgerBytes,bindingLen,verifiedShape)||
               verifiedShape.bindings.empty())return false;
            pending.bindingLedger.assign(ledgerBytes,ledgerBytes+bindingLen);
        }
        const auto got=state_detail::get32(bytes,size-4);
        if(got!=state_detail::crc32(bytes,size-4))return false;
        const auto* data=bytes+S::kLegacySize+4;
        pending.package.assign(data,data+packageLen);
    }
    destination=std::move(pending);
    return true;
}
} // namespace fw
