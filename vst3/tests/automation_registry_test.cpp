#include "../src/parameter_registry.h"
#include <cmath>
#include <cstdio>
#include <cstdlib>

static void require(bool ok,const char* why) {
    if(!ok) {std::fprintf(stderr,"automation-registry FAIL: %s\n",why);std::abort();}
}
int main() {
    using namespace fw;
    require(kActiveCount==34,"all 34 current DSP parameter contracts");
    require(kParamCount==128 && kEngineBegin==64,"host slot contract");
    bool used[kParamCount]={};
    for(const auto& p:kParams) {
        require(p.id<64&&!used[p.id],"distinct stable host IDs");
        used[p.id]=true;
        require(p.name&&p.name[0]&&p.unit,"descriptor readable");
        require(std::isfinite(p.initial)&&p.initial>=p.min&&p.initial<=p.max,
            "valid canonical defaults");
        const double norm=normalizedFromPhysical(p,p.initial);
        require(std::isfinite(norm)&&norm>=0.&&norm<=1.,"default normalized");
        const double physical=physicalFromNormalized(p,norm);
        require(std::abs(physical-p.initial)<std::max(1e-6,p.initial*1e-7),
            "default physical normalized roundtrip");
        for(int i=0;i<=1000;i++) {
            const double n=i/1000.;
            const double value=physicalFromNormalized(p,n);
            require(std::isfinite(value)&&value>=p.min-1e-7&&value<=p.max+1e-6,
                "finite in-range physical automation");
            const double back=normalizedFromPhysical(p,value);
            require(back>=0.&&back<=1.,"finite normalized automation");
            if(p.scale!=Scale::Discrete&&p.scale!=Scale::FrequencyWithZero&&
               p.scale!=Scale::ClockRate)
               require(std::abs(back-n)<1e-8,"smooth automation invertible");
        }
    }
    for(int i=0;i<34;i++)require(used[i],"no holes in primary host parameters");
    for(int i=34;i<128;i++)require(!used[i],"reserved+engine slot not reassigned");
    require(kParams[0].id==0&&kParams[0].initial==1.,"Wet preserved");
    require(kParams[1].id==1&&kParams[1].steps==1,"Bypass preserved");
    require(kParams[9].id==9&&kParams[10].id==10&&kParams[11].id==11,
        "S2 semantic class IDs unchanged");
    require(std::abs(bandFromNorm(.2)-20.)<1e-8,"L/H 20Hz breakpoint");
    require(std::abs(bandFromNorm(1.)-20000.)<1e-8,"L/H max 20kHz");
    require(zeroFreqFromNorm(0.)==0.,"pivot exact 0Hz");
    require(std::abs(zeroFreqFromNorm(normFromZeroFreq(350.))-350.)<1e-8,
        "pivot frequency conversion");
    require(physicalFromNormalized(kParams[16],.5)==9.,
        "integer bit depth correct");
    require(physicalFromNormalized(kParams[20],1.)==64.,
        "denominator upper boundary");
    require(physicalFromNormalized(kParams[21],0.)==-128.,
        "signed harmonic number lower boundary");
    require(physicalFromNormalized(kParams[33],0.)==4.&&
        physicalFromNormalized(kParams[33],1.)==8.,
        "overlap only supported discrete values");
    require(physicalFromNormalized(kParams[17],0.)==0.,
        "crusher 0Hz special hold");
    require(std::abs(physicalFromNormalized(kParams[17],1.,48000.)-48000.)<1e-6,
        "crusher sample-rate-aware Nyquist grid");
    require(std::abs(physicalFromNormalized(kParams[17],1.,96000.)-96000.)<1e-6,
        "crusher automation normalized independent of host sample rate");
    require(defaultHostValues()[12]==0.,"default 1024 FFT");
    require(defaultHostValues()[25]==1.,"B STFT default");
    require(defaultHostValues()[31]==0.,"Reciprocal mode default");
    require(defaultHostValues()[64]==.5,"unbound engine slot neutral");
    std::puts("34 Frequency Warp DSP parameter descriptors PASS");
}
