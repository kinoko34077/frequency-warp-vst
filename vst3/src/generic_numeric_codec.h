#pragma once
// R3C2B: deterministic, allocation-free normalized <-> canonical codec for
// verified generic slot64..127 descriptors. This is mathematical machinery,
// NOT authentication or permission to dispatch DSP/DAW events.
// The values/scale/steps must originate from WASM-attested semantics through
// R3C2A and only become active after R3C2C publishes an authorized epoch.
#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
namespace fw {
enum class GenericScale : std::uint8_t {
    Linear, Log, Discrete, FrequencyBand, FrequencyWithZero
};
struct GenericNumericCodec {
    std::uint32_t hostSlot=0;
    std::uint32_t codecRevision=0;
    GenericScale scale=GenericScale::Linear;
    double min=0.,max=1.,def=0.5;
    std::uint32_t steps=0;
    std::array<double,32> snapValues{};
    std::uint32_t snapCount=0;
    double snapRadiusNormalized=0.;
};
inline bool validGenericNumericCodec(const GenericNumericCodec& c) noexcept {
    if(c.hostSlot<64||c.hostSlot>127||c.codecRevision!=1 ||
       !std::isfinite(c.min)||!std::isfinite(c.max)||
       !std::isfinite(c.def)||std::abs(c.min)>1e9||
       std::abs(c.max)>1e9||std::abs(c.def)>1e9||
       !(c.min<c.max)||c.def<c.min||c.def>c.max||
       c.snapCount>32||!std::isfinite(c.snapRadiusNormalized)||
       c.snapRadiusNormalized<0.||c.snapRadiusNormalized>.25)
        return false;
    switch(c.scale) {
        case GenericScale::Linear:
            if(c.steps!=0)return false;break;
        case GenericScale::Log:
            if(c.min<=0.||c.steps!=0||!std::isfinite(c.max/c.min))
                return false;break;
        case GenericScale::Discrete:
            if(c.steps==0||c.steps>65535)return false;
            {
                const double n=(c.def-c.min)*c.steps/(c.max-c.min);
                if(std::abs(n-std::round(n))>1e-9)return false;
            }
            break;
        case GenericScale::FrequencyBand:
            if(c.min!=.001||c.max!=20000.||c.steps!=0)return false;break;
        case GenericScale::FrequencyWithZero:
            if(c.min!=0.||c.max!=20000.||c.steps!=0)return false;break;
        default:return false;
    }
    for(std::uint32_t i=0;i<c.snapCount;i++){
        if(!std::isfinite(c.snapValues[i]) ||
           c.snapValues[i]<c.min||c.snapValues[i]>c.max)return false;
        for(std::uint32_t j=0;j<i;j++)
            if(c.snapValues[i]==c.snapValues[j])return false;
    }
    return true;
}
inline bool genericCanonicalToNormalized(const GenericNumericCodec& c,
                                         double physical,double& result) noexcept {
    if(!validGenericNumericCodec(c)||!std::isfinite(physical) ||
       physical<c.min||physical>c.max)return false;
    double n=0.;
    switch(c.scale){
        case GenericScale::Log:
            n=std::log(physical/c.min)/std::log(c.max/c.min);break;
        case GenericScale::Discrete:
            n=std::round((physical-c.min)*c.steps/(c.max-c.min))/c.steps;break;
        case GenericScale::FrequencyBand:
            n=physical<=20. ?
                .2*std::log(physical/.001)/std::log(20000.) :
                .2+.8*std::log(physical/20.)/std::log(1000.);
            break;
        case GenericScale::FrequencyWithZero:
            if(physical==0.)n=0.;
            else if(physical<=20.)
                n=(1.+199.*std::log(physical/.001)/std::log(20000.))/1000.;
            else n=.2+.8*std::log(physical/20.)/std::log(1000.);
            break;
        case GenericScale::Linear:
            n=(physical-c.min)/(c.max-c.min);break;
        default:return false;
    }
    if(!std::isfinite(n))return false;
    result=std::clamp(n,0.,1.);
    return true;
}
inline bool genericNormalizedToCanonical(const GenericNumericCodec& c,
                                         double normalized,double& result,
                                         bool applySnap=false) noexcept {
    if(!validGenericNumericCodec(c)||!std::isfinite(normalized)||
       normalized<0.||normalized>1.)return false;
    double v=0.;
    switch(c.scale){
        case GenericScale::Log:
            v=c.min*std::pow(c.max/c.min,normalized);break;
        case GenericScale::Discrete:
            v=c.min+(c.max-c.min)*std::round(normalized*c.steps)/c.steps;break;
        case GenericScale::FrequencyBand:
            v=normalized<=.2 ?
                .001*std::exp(std::log(20000.)*normalized/.2) :
                20.*std::exp(std::log(1000.)*(normalized-.2)/.8);
            break;
        case GenericScale::FrequencyWithZero:
            if(normalized==0.)v=0.;
            else if(normalized<=.2)
                v=.001*std::exp(std::log(20000.)*
                    (std::max(normalized,.001)*1000.-1.)/199.);
            else v=20.*std::exp(std::log(1000.)*(normalized-.2)/.8);
            break;
        case GenericScale::Linear:
            v=c.min+(c.max-c.min)*normalized;break;
        default:return false;
    }
    if(!std::isfinite(v))return false;
    if(applySnap && c.snapCount){
        double bestDistance=2.;
        double nearest=v;
        for(std::uint32_t i=0;i<c.snapCount;i++){
            double targetN=0.;
            if(!genericCanonicalToNormalized(c,c.snapValues[i],targetN))
                return false;
            const double distance=std::abs(targetN-normalized);
            if(distance<bestDistance){bestDistance=distance;nearest=c.snapValues[i];}
        }
        if(bestDistance<=c.snapRadiusNormalized)v=nearest;
    }
    result=std::clamp(v,c.min,c.max);
    return true;
}
} // namespace fw
