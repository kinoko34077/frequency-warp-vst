#include "../src/stream_host_events.h"
#include <array>
#include <cmath>
#include <cstdio>
#include <cstdlib>
static void check(bool v,const char* message) {
    if(!v){std::fprintf(stderr,"FAILED %s\n",message);std::abort();}
}
int main(){
    const double rate=48000.;
    auto vals=fw::defaultHostValues();
    fw::StreamHostEvents e;
    check(e.start(vals,rate),"initial host snapshot");
    check(e.count()==11,"eleven stable core Stream controls");
    const auto* a=e.data();
    check(a[0].id==2 && a[1].id==3 && a[2].id==4 && a[3].id==5,
          "stable DAW ID order");
    check(a[4].id==6 && a[5].id==7 && a[6].id==8 &&
          a[7].id==9 && a[8].id==10 &&
          a[9].id==13 && a[10].id==18,
          "verified spectral geometry/reflection DAW IDs");
    check(std::abs(a[0].value-20.)<1.e-5 &&
          std::abs(a[1].value-16000.)<1.e-5 &&
          a[2].value==0. && a[3].value==1.,
          "initial physical engine contract");
    check(a[4].value==0. && std::abs(a[5].value-350.)<1.e-5 &&
          a[6].value==1. && a[7].value==1. &&
          a[8].value==0. && a[9].value==0. && a[10].value==0.,
          "physical geometry/ring/reflect/rational initial snapshot");
    vals[2]=fw::normalizedFromPhysical(fw::kParams[2],500.);
    vals[3]=fw::normalizedFromPhysical(fw::kParams[3],7000.);
    vals[4]=0.75;vals[5]=0.35;
    check(e.start(vals,rate),"snapshots after state/project restore");
    check(std::abs(e.data()[0].value-500.)<0.00001 &&
          std::abs(e.data()[1].value-7000.)<0.00001,
          "actual Hz not normalized rail position");
    check(std::abs(e.data()[2].value-0.75)<1e-8 &&
          std::abs(e.data()[3].value-0.35)<1e-8,
          "actual invert and curvature normalized as physical fractions");
    // 11 host snapshot events plus 29*4 changes =127; the next event
    // fits, but a 128+1st must cause a fresh PCM packet before consuming it.
    for(unsigned frame=1;frame<=29;frame++){
        check(e.hasRoom(4),"dense sample offsets fit bounded input");
        for(unsigned id=2;id<=5;id++)
            check(e.append(id,frame,vals[id],rate),"append dense control");
    }
    check(e.count()==127&&e.hasRoom(1),"bounded near-full packet");
    check(e.append(13,30,vals[13],rate),"last event slot valid");
    check(e.count()==128&&!e.hasRoom(1),"bounded packet full");
    check(!e.append(4,30,.4,rate),"overflow refused");
    check(e.data()[127].id==13 && e.data()[127].offset==30,
          "no truncated/unordered event offsets");
    fw::StreamHostEvents next;
    check(next.start(vals,rate)&&next.count()==11,
          "next chunk restarts with entire stable state");
    check(fw::StreamHostEvents::indexOf(18)==10 &&
          fw::StreamHostEvents::indexOf(11)==-1,
          "explicit non-contiguous host binding table");
    check(!next.append(64,1,.5,rate),"generic slot is not silently rebound");
    std::puts("PASS DAW normalized-to-physical host controls and dense 128-event bound");
}
