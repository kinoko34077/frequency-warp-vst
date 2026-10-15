#include "../../src/generic_host_packet.h"
#include <cmath>
#include <iostream>
#include <limits>
#include <stdexcept>
static void need(bool yes,const char* why){if(!yes)throw std::runtime_error(why);}
int main(){
    try {
        fw::GenericHostPacket p;
        const FWNativeGenericCodec gain{64,1,0,0,0.,4.,0.5};
        need(p.appendPhysical({2,0,20.}),"stream initial");
        need(p.append(gain,64,0,.25),"gain initial");
        need(p.data()[1].id==64&&p.data()[1].value==1.,"gain canonical");
        need(p.append(gain,64,12,.5),"sample-offset");
        need(p.data()[2].offset==12&&p.data()[2].value==2.,"offset preserved");
        const auto prior=p.count();
        need(!p.append(gain,64,11,.5)&&p.count()==prior,"order fail atomic");
        need(!p.append(gain,65,12,.5)&&p.count()==prior,"slot mismatch");
        need(!p.append(gain,64,12,std::numeric_limits<double>::quiet_NaN()),"nan");
        need(!p.append(gain,64,12,-.01),"out of range");
        FWNativeGenericCodec invalid=gain;
        invalid.scale=99;
        need(!p.append(invalid,64,12,.5),"scale denial");
        p.clear();
        for(unsigned i=0;i<128;i++) {
            const std::uint32_t offset=i/2;
            need(p.append(gain,64,offset,.25),"capacity fill");
        }
        need(!p.append(gain,64,64,.25)&&p.count()==128,"overflow must reject");
        p.clear();
        FWNativeGenericCodec step{127,1,2,4,-2.,2.,0.};
        need(p.append(step,127,0,.61),"discrete");
        need(p.data()[0].value==0.,"discrete step rounding");
        FWNativeGenericCodec log{64,1,1,0,1.,100.,10.};
        need(p.append(log,64,2,.5),"log");
        need(std::abs(p.data()[1].value-10.)<1e-10,"log conversion");
        std::cout<<"R3C2C2 foundation PASS: bounded canonical packet, ordering, invalid/overflow\n";
    }catch(const std::exception& e){
        std::cerr<<"R3C2C2 foundation FAIL: "<<e.what()<<'\n';return 1;
    }
}
