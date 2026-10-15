#pragma once
// R3C2C2 packet foundation. Portable fixed-capacity generic event transport.
// This is only a validated packet builder: a later integration MUST bind
// source and worker consumption to the same live authorization ticket/epoch.
// Never use this alone to authorize a DAW or native Wasmi edit.
#include "generic_numeric_codec.h"
#include "native_engine_abi.h"
#include <array>
#include <cstdint>
#include <cmath>

namespace fw {
class GenericHostPacket final {
public:
    static constexpr std::uint32_t kCapacity=128;
    std::uint32_t count() const noexcept {return used_;}
    const FWNativeEvent* data() const noexcept {return events_.data();}
    bool hasRoom(std::uint32_t n) const noexcept {
        return n<=kCapacity-used_;
    }
    void clear() noexcept {used_=0;}
    // Caller must validate the current authorization ticket before invoking.
    // Failed conversion or capacity check never changes the event buffer.
    bool append(const FWNativeGenericCodec& wasm,std::uint32_t slot,
                std::uint32_t offset,double normalized) noexcept {
        if(slot<64||slot>127||slot!=wasm.hostSlot||
           wasm.codecRevision!=1||wasm.scale>4||
           !hasRoom(1)||!std::isfinite(normalized)||
           normalized<0.||normalized>1.||
           (used_ && offset<events_[used_-1].offset))return false;
        GenericNumericCodec codec{};
        codec.hostSlot=wasm.hostSlot;
        codec.codecRevision=wasm.codecRevision;
        codec.scale=static_cast<GenericScale>(wasm.scale);
        codec.min=wasm.min;codec.max=wasm.max;codec.def=wasm.defaultValue;
        codec.steps=wasm.steps;
        double canonical=0.;
        if(!genericNormalizedToCanonical(codec,normalized,canonical)||
           !std::isfinite(canonical))return false;
        events_[used_++]={slot,offset,canonical};
        return true;
    }
    // Append a validated physical Stream event, preserving the unified
    // 128-entry budget and sample order. No silently overwritten events.
    bool appendPhysical(const FWNativeEvent& e) noexcept {
        if(!hasRoom(1)||!std::isfinite(e.value)||
           (used_ && e.offset<events_[used_-1].offset))return false;
        events_[used_++]=e;
        return true;
    }
private:
    std::array<FWNativeEvent,kCapacity> events_{};
    std::uint32_t used_=0;
};
} // namespace fw
