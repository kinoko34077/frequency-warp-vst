#pragma once
// Stable DAW-visible Frequency Warp parameter contract, issue #86.
// First released Processor/Controller class IDs and ParamIDs are unchanged.
// Normalized VST3 [0,1] transport is separate from canonical DSP units.
#include "delay.h"
#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>

namespace fw {
enum class Scale : uint8_t { Linear, Discrete, FrequencyBand, FrequencyWithZero, ClockRate };
struct Param {
    uint32_t id;
    const char* name;
    const char* unit;
    Scale scale;
    double min;
    double max;
    double initial;
    uint32_t steps; // number of intervals; 0 is continuous
};
// ParamID 0..12 come from accepted S2 and MUST remain stable.
// IDs 13..33 specify the independent current Web DSP controls.
// 34..63 shell-reserved; 64..127 module-generic, unbound by default.
// GUI-only sine/graph preview are NOT spectral DSP controls.
inline constexpr std::array<Param,34> kParams{{
    {0,"Wet","%",Scale::Linear,0,1,1,0},
    {1,"Bypass","",Scale::Discrete,0,1,0,1},
    {2,"Lower Frequency","Hz",Scale::FrequencyBand,.001,20000,20,0},
    {3,"Upper Frequency","Hz",Scale::FrequencyBand,.001,20000,16000,0},
    {4,"Invert","%",Scale::Linear,0,1,0,0},
    {5,"Curvature","",Scale::Linear,0,1,1,0},
    {6,"Axis Shift","u",Scale::Linear,-2,2,0,0},
    {7,"Axis Pivot","Hz",Scale::FrequencyWithZero,0,20000,350,0},
    {8,"Axis Slope","x",Scale::Linear,-4,4,1,0},
    {9,"Reflection Synthesis","%",Scale::Linear,0,1,1,0},
    {10,"Ring Enabled","",Scale::Discrete,0,1,0,1},
    {11,"Crusher Enabled","",Scale::Discrete,0,1,0,1},
    {12,"FFT Quality","",Scale::Discrete,0,2,0,2},
    {13,"Reflection Decay","%",Scale::Linear,0,1,0,0},
    {14,"Ring Carrier","Hz",Scale::FrequencyWithZero,0,20000,350,0},
    {15,"Carrier Fold Link","",Scale::Discrete,0,1,0,1},
    {16,"Crusher Bits","bits",Scale::Discrete,2,16,8,14},
    {17,"Crusher Clock","Hz",Scale::ClockRate,0,192000,12000,0},
    {18,"Rational Layout","",Scale::Discrete,0,1,0,1},
    {19,"Fundamental F","Hz",Scale::Linear,20,2000,350,0},
    {20,"Denominator m","",Scale::Discrete,1,64,4,63},
    {21,"Numerator n","",Scale::Discrete,-128,128,-3,256},
    {22,"Harmonic Index q","",Scale::Discrete,1,32,1,31},
    {23,"Pitch Ratio r","x",Scale::Linear,.25,4,1,0},
    {24,"H to Pivot Link","",Scale::Discrete,0,1,0,1},
    {25,"Engine Choice","",Scale::Discrete,0,1,1,1},
    {26,"Engine Auto","",Scale::Discrete,0,1,0,1},
    {27,"Engine A Floor","Hz",Scale::FrequencyBand,.001,20000,20,0},
    {28,"Engine A Quality","%",Scale::Linear,0,1,0,0},
    {29,"Engine A Bands","",Scale::Discrete,1,8,1,7},
    {30,"Engine A Reverb","%",Scale::Linear,0,1,0,0},
    {31,"Warp Mode","",Scale::Discrete,0,2,0,2},
    {32,"Outside Policy","",Scale::Discrete,0,1,0,1},
    {33,"STFT Overlap","",Scale::Discrete,4,8,4,1},
}};
static_assert(kParamCount==128 && kEngineBegin==64, "fixed host slot IDs changed");
constexpr uint32_t kActiveCount=static_cast<uint32_t>(kParams.size());
inline const Param* findParam(uint32_t id) noexcept {
    return id<kActiveCount?&kParams[id]:nullptr;
}
inline double clamp01(double v) noexcept {
    return std::isfinite(v)?std::clamp(v,0.,1.):0.;
}
inline double clampPhysical(const Param& p,double v) noexcept {
    return std::isfinite(v)?std::clamp(v,p.min,p.max):p.initial;
}
// 20 Hz division exactly tracks current Web L/H/A-min log track;
// unlike percent-as-Hz approximation, 0.2 maps precisely to 20 Hz.
inline double bandFromNorm(double n) noexcept {
    n=clamp01(n);
    return n<=.2 ? .001*std::pow(20000.,n/.2)
                 : 20.*std::pow(1000.,(n-.2)/.8);
}
inline double normFromBand(double hz) noexcept {
    hz=std::clamp(hz,.001,20000.);
    return hz<=20. ? .2*std::log(hz/.001)/std::log(20000.)
                   : .2+.8*std::log(hz/20.)/std::log(1000.);
}
// Special 0 Hz value with a continuous positive band at 0.001..20000 Hz.
// The dead zone (0..0.001 normalized) maps to exactly 0.001 Hz.
inline double zeroFreqFromNorm(double n) noexcept {
    n=clamp01(n);
    if(n==0.)return 0.;
    if(n<=.2)return .001*std::pow(20000.,(std::max(n,.001)*1000.-1.)/199.);
    return 20.*std::pow(1000.,(n-.2)/.8);
}
inline double normFromZeroFreq(double hz) noexcept {
    if(!(hz>0.))return 0.;
    hz=std::clamp(hz,.001,20000.);
    if(hz<=20.)return (1.+199.*std::log(hz/.001)/std::log(20000.))/1000.;
    return .2+.8*std::log(hz/20.)/std::log(1000.);
}
// At normal rates the effective clock is Fs * pow(10^-5, 1-n).
// The host records a stable rate *relative to sample rate*; readout in Hz
// is derived using the current sampleRate, not persisted as arbitrary Hz.
inline double physicalFromNormalized(const Param& p,double normalized,
    double sampleRate=48000.) noexcept {
    const double n=clamp01(normalized);
    switch(p.scale) {
        case Scale::FrequencyBand: return bandFromNorm(n);
        case Scale::FrequencyWithZero: return zeroFreqFromNorm(n);
        case Scale::ClockRate: {
            const double fs=std::isfinite(sampleRate)&&sampleRate>0.?sampleRate:48000.;
            return n==0.?0.:fs*std::pow(1.e-5,1.-n);
        }
        case Scale::Discrete: {
            const double q=p.steps?std::round(n*p.steps)/p.steps:n;
            return p.min+(p.max-p.min)*q;
        }
        default:return p.min+(p.max-p.min)*n;
    }
}
inline double normalizedFromPhysical(const Param& p,double value,
    double sampleRate=48000.) noexcept {
    const double v=clampPhysical(p,value);
    switch(p.scale) {
        case Scale::FrequencyBand: return normFromBand(v);
        case Scale::FrequencyWithZero: return normFromZeroFreq(v);
        case Scale::ClockRate: {
            const double fs=std::isfinite(sampleRate)&&sampleRate>0.?sampleRate:48000.;
            return v<=0.?0.:clamp01(1.+std::log(std::min(v,fs)/fs)/std::log(1.e5));
        }
        case Scale::Discrete: {
            const double n=(v-p.min)/(p.max-p.min);
            return p.steps?std::round(n*p.steps)/p.steps:n;
        }
        default:return clamp01((v-p.min)/(p.max-p.min));
    }
}
inline const char* discreteLabel(uint32_t id,int value) noexcept {
    switch(id) {
        case 1:case 10:case 11:case 15:case 18:case 24:case 26:
            return value?"On":"Off";
        case 12: return value==0?"Eco 1024":value==1?"Standard 2048":"High 4096";
        case 25: return value==0?"A Partials":"B STFT";
        case 31: return value==0?"Reciprocal":value==1?"Fold L":"Fold H";
        case 32: return value==0?"Pass":"Kill";
        case 33: return value==4?"4x":"8x";
        default:return nullptr;
    }
}
inline std::array<double,kParamCount> defaultHostValues() noexcept {
    std::array<double,kParamCount> result{};
    result.fill(.5); // reserved/generic neutral, no module binding
    for(const auto& p:kParams)result[p.id]=normalizedFromPhysical(p,p.initial);
    return result;
}
} // namespace fw
