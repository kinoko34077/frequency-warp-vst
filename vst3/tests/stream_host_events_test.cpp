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
    check(e.count()==4,"four stable core Stream controls");
    const auto* a=e.data();
    check(a[0].id==2 && a[1].id==3 && a[2].id==4 && a[3].id==5,
          "stable DAW ID order");
    check(std::abs(a[0].value-20.)<1.e-5 &&
          std::abs(a[1].value-16000.)<1.e-5 &&
          a[2].value==0. && a[3].value==1.,
          "initial physical engine contract");
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
    // Simulate dense 4-controls-per-frame host automation:
    // 4 initial + 31*4 = 128; a new chunk must begin before frame 32.
    for(unsigned frame=1;frame<=31;frame++){
        check(e.hasRoom(4),"dense sample offsets fit bounded input");
        for(unsigned id=2;id<=5;id++)
            check(e.append(id,frame,vals[id],rate),"append dense control");
    }
    check(e.count()==128&&!e.hasRoom(1),"bounded packet full");
    check(!e.append(4,32,.4,rate),"overflow refused");
    check(e.data()[127].id==5 && e.data()[127].offset==31,
          "no truncated/unordered event offsets");
    fw::StreamHostEvents next;
    check(next.start(vals,rate)&&next.count()==4,
          "next chunk restarts with entire stable state");
    check(!next.append(64,1,.5,rate),"generic slot is not silently rebound");
    std::puts("PASS DAW normalized-to-physical host controls and dense 128-event bound");
}
