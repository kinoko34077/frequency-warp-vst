#pragma once
// S4b1: fixed physical host automation for a VERIFIED shared Stream package.
// Conversion is based on stable VST3 ParamID registry; IDs never change.
// Sound thread owns this POD; never does Rust calls or allocation.
#include "native_engine_abi.h"
#include "parameter_registry.h"
#include <array>
#include <cstdint>

namespace fw {
class StreamHostEvents {
public:
    static constexpr uint32_t kFirst=2,kLast=5,kInitial=4;
    static constexpr uint32_t kMax=128;
    static bool bound(uint32_t id) noexcept {return id>=kFirst&&id<=kLast;}
    bool start(const std::array<double,kParamCount>& normalized,
               double rate) noexcept {
        size_=0;
        for(uint32_t id=kFirst;id<=kLast;id++){
            if(!append(id,0,normalized[id],rate))return false;
        }
        return true;
    }
    bool hasRoom(uint32_t count) const noexcept {return count<=kMax-size_;}
    bool append(uint32_t id,uint32_t offset,double norm,double rate) noexcept {
        if(!bound(id)||!hasRoom(1)||!std::isfinite(norm)||norm<0||norm>1)return false;
        events_[size_++]={id,offset,physicalFromNormalized(kParams[id],norm,rate)};
        return true;
    }
    uint32_t count() const noexcept {return size_;}
    const FWNativeEvent* data() const noexcept {return events_.data();}
private:
    std::array<FWNativeEvent,kMax> events_{};
    uint32_t size_=0;
};
} // namespace fw
