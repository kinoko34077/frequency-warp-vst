#pragma once
#include <array>
#include <cstdint>

namespace fw {
constexpr uint32_t kLatency=4095, kParamCount=128, kEngineBegin=64;
// Fixed-latency Dry/Bypass fallback. No allocations, locks or syscalls in audio process.
class Delay {
public:
    void reset() noexcept {
        for(auto& ch:buf_) ch.fill(0.0);
        pos_=0;
    }
    template <class T> T tick(uint32_t channel, T sample) noexcept {
        const double old=buf_[channel][pos_];
        buf_[channel][pos_]=static_cast<double>(sample);
        return static_cast<T>(old);
    }
    void next() noexcept {if(++pos_==kLatency)pos_=0;}
private:
    std::array<std::array<double,kLatency>,2> buf_{};
    uint32_t pos_=0;
};
} // namespace fw
