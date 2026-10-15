#include "../../src/generic_numeric_codec.h"
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <limits>
static void check(bool ok,const char* msg) {
    if(!ok){std::fprintf(stderr,"R3C2B codec FAIL: %s\n",msg);std::abort();}
}
static bool near(double x,double y,double eps=1e-9){
    return std::abs(x-y)<=eps*std::max(1.,std::abs(y));
}
static fw::GenericNumericCodec make(fw::GenericScale scale,
                                    double min,double max,double def,
                                    unsigned steps=0,unsigned slot=64){
    fw::GenericNumericCodec c{};
    c.hostSlot=slot;c.codecRevision=1;c.scale=scale;c.min=min;
    c.max=max;c.def=def;c.steps=steps;
    return c;
}
static double forward(const fw::GenericNumericCodec& c,double n,bool snap=false){
    double out=12345.;
    check(fw::genericNormalizedToCanonical(c,n,out,snap),"expected normalized transfer");
    return out;
}
static double inverse(const fw::GenericNumericCodec& c,double x){
    double out=12345.;
    check(fw::genericCanonicalToNormalized(c,x,out),"expected canonical transfer");
    return out;
}
int main(){
    using namespace fw;
    auto linear=make(GenericScale::Linear,-4.,4.,1.);
    auto log=make(GenericScale::Log,.25,4.,1.);
    auto discrete=make(GenericScale::Discrete,1.,8.,1.,7);
    auto band=make(GenericScale::FrequencyBand,.001,20000.,20.);
    auto zero=make(GenericScale::FrequencyWithZero,0.,20000.,350.);
    auto boolean=make(GenericScale::Discrete,0.,1.,0.,1,127);
    for(const auto& c:{linear,log,discrete,band,zero,boolean})
        check(validGenericNumericCodec(c),"valid WASM canonical range");
    check(near(forward(linear,.5),0.),"linear midpoint");
    check(near(forward(log,.5),1.),"log geometric midpoint");
    check(near(forward(discrete,.4),4.),"discrete positive quantization");
    check(near(inverse(discrete,4.),3./7.),"discrete canonical normalization");
    check(near(forward(boolean,.49),0.)&&near(forward(boolean,.51),1.),
          "boolean 0/1 quantization");
    check(near(forward(band,0.),.001)&&near(forward(band,.2),20.,1e-12)&&
          near(forward(band,1.),20000.,1e-12),
          "shared FrequencyBand 0.001 / 20 / 20000Hz transfer");
    check(near(inverse(band,20.),.2,1e-12),"20Hz inverse breakpoint");
    check(forward(zero,0.)==0.&&near(forward(zero,.001),.001,1e-12)&&
          near(forward(zero,.2),20.,1e-12),
          "special zeroHz and dead-zone boundary");
    check(near(inverse(zero,0.),0.)&&near(inverse(zero,.001),.001,1e-12),
          "zeroHz inverse and intentionally noninvertible deadzone");
    for(const auto& c:{linear,log,band}){
        for(unsigned i=0;i<=100;++i){
            const double n=i/100.;
            check(near(inverse(c,forward(c,n)),n,1e-10),
                  "roundtrip must agree with site JS linear/log/band");
        }
    }
    for(unsigned i=2;i<=100;++i){ // zero mapping n>=.002 is bijective
        const double n=i/100.;
        check(near(inverse(zero,forward(zero,n)),n,1e-10),
              "zero-allowed frequency roundtrip after dead zone");
    }
    linear.snapValues[0]=-1.;
    linear.snapValues[1]=0.;
    linear.snapValues[2]=1.;
    linear.snapCount=3;
    linear.snapRadiusNormalized=.03;
    check(near(forward(linear,.63,true),1.),"snap +1 in normalized rail range");
    check(near(forward(linear,.63,false),1.04),"snap opt-out bypass");
    check(near(forward(linear,.55,true),.4),
          "outside capture radius cannot be snapped");
    auto broken=linear;broken.snapValues[1]=broken.snapValues[0];
    check(!validGenericNumericCodec(broken),"duplicate capture target fails");
    broken=linear;broken.snapRadiusNormalized=.5;
    check(!validGenericNumericCodec(broken),"unbounded snap capture radius fails");
    broken=linear;broken.hostSlot=33;
    check(!validGenericNumericCodec(broken),"legacy IDs may not be generic");
    broken=linear;broken.codecRevision=2;
    check(!validGenericNumericCodec(broken),"unknown transfer codec version");
    broken=log;broken.min=0.;
    check(!validGenericNumericCodec(broken),"log zero invalid");
    broken=log;broken.min=std::numeric_limits<double>::denorm_min();
    check(!validGenericNumericCodec(broken),"log ratio overflow fails");
    broken=discrete;broken.steps=0;
    check(!validGenericNumericCodec(broken),"discrete without step invalid");
    broken=band;broken.min=0.;
    check(!validGenericNumericCodec(broken),"FrequencyBand range immutable");
    double unchanged=73.;
    check(!genericNormalizedToCanonical(linear,-.01,unchanged)&&unchanged==73.,
          "invalid host rail cannot mutate previous value");
    check(!genericNormalizedToCanonical(linear,std::numeric_limits<double>::quiet_NaN(),unchanged)&&unchanged==73.,
          "NaN host rail never accepted");
    check(!genericCanonicalToNormalized(linear,9.,unchanged)&&unchanged==73.,
          "out-of-range physical value rejected atomically");
    check(!genericCanonicalToNormalized(linear,std::numeric_limits<double>::infinity(),unchanged)&&unchanged==73.,
          "infinite physical event rejected");
    std::puts("PASS R3C2B: canonical/normalized/step/snap math and boundaries");
}
