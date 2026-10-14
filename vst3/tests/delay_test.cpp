#include "../src/delay.h"
#include <cstdlib>
static void check(bool passed) { if (!passed) std::abort(); }
#include <cmath>
using namespace fw;
int main() {
    static_check(kLatency==4095 && kParamCount==128 && kEngineBegin==64);
    Delay a,b;
    for(int i=0;i<8192;i++) {
        const auto l=a.tick(0,i==0?0.75f:0.0f);
        const auto r=a.tick(1,i==0?0.375f:0.0f);
        check(std::abs(l-(i==4095?0.75f:0.0f))<1e-7f);
        check(std::abs(r-(i==4095?0.375f:0.0f))<1e-7f);
        a.next();
    }
    a.reset();check(a.tick(0,0.0f)==0.0f);a.next();
    b.tick(0,1.0);b.next();
    for(int i=0;i<4094;i++){b.tick(0,0.0);b.next();}
    check(std::abs(b.tick(0,0.0)-1.0)<1e-12);
    a.reset();
    const double precise=0.12345678912345;
    a.tick(0,precise);a.next();
    for(int i=0;i<4094;i++){a.tick(0,0.0);a.next();}
    check(std::abs(a.tick(0,0.0)-precise)<1e-14);
}
