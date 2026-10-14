#include "../../src/async_pcm_mailbox.h"
#include <array>
#include <cstdio>
#include <cstdlib>
#include <cmath>
#include <cstdint>

static void check(bool ok,const char* why){
    if(!ok){std::fprintf(stderr,"async PCM FAIL: %s\n",why);std::abort();}
}
struct GainContext {double gain=1.0;bool fail=false;};
static int32_t mockModule(void* ctx,const float* input,float* output,
    uint32_t frames,const FWNativeEvent* events,uint32_t n){
    auto& state=*static_cast<GainContext*>(ctx);
    if(state.fail)return -2;
    uint32_t ev=0;
    for(uint32_t i=0;i<frames;i++){
        while(ev<n&&events[ev].offset==i){
            if(events[ev].id==64)state.gain=events[ev].value;
            ++ev;
        }
        // Test caller always uses stereo planar in these cases.
        output[i]=static_cast<float>(input[i]*state.gain);
        output[frames+i]=static_cast<float>(input[frames+i]*state.gain);
    }
    if(frames==0&&n>0)state.gain=events[n-1].value;
    return 0;
}
static void deadlineAndAutomation(){
    fw::AsyncPcmMailbox queue;
    GainContext g{};
    check(queue.workerConfigure(mockModule,&g,0),"load zero-latency module");
    std::array<float,128> l{},r{};
    l.fill(.8f);r.fill(.4f);
    const float* in[]={l.data(),r.data()};
    FWNativeEvent ev{64,64,.25};
    check(queue.rtSubmit(in,2,128,&ev,1),"submit stereo PCM and event");
    check(queue.rtNextTime()==128,"timeline advances exactly once");
    check(queue.workerStep(),"worker runs off RT");
    float out[2]{};
    for(uint64_t t=0;t<4095;t++)
        check(!queue.rtReadWet(t,2,out),"not before fixed PDC");
    for(uint64_t t=4095;t<4095+128;t++){
        check(queue.rtReadWet(t,2,out),"exact wet deadline");
        const float multiplier=t-4095<64?1.0f:0.25f;
        check(std::abs(out[0]-.8f*multiplier)<1e-6f&&
              std::abs(out[1]-.4f*multiplier)<1e-6f,
              "sample-accurate stereo planar automation");
    }
    check(!queue.rtReadWet(4223,2,out),"no old wet packet reuse");

    const FWNativeEvent zero{64,0,.75};
    check(queue.rtSubmit(nullptr,2,0,&zero,1),"zero-frame automation flush");
    check(queue.workerStep(),"process zero frame off RT");
    check(queue.rtSubmit(in,2,128),"next PCM chunk");
    check(queue.workerStep(),"process after zero flush");
    check(queue.rtReadWet(4223,2,out),"next wet block starts on timeline");
    check(std::abs(out[0]-.6f)<1e-6f&&std::abs(out[1]-.3f)<1e-6f,
          "zero-frame parameter persisted");

    // An entirely late chunk must be dropped, not spliced from its middle.
    check(queue.rtSubmit(in,2,128),"late chunk queued");
    check(queue.workerStep(),"worker finished late chunk");
    check(!queue.rtReadWet(4352,2,out),"late chunk entirely discarded");
    check(queue.stats().discardedWet>=1,"late output counted");
}
static void faultsAndGenerations(){
    fw::AsyncPcmMailbox queue;
    GainContext g{};
    float l[128]{},r[128]{};
    l[0]=.8f;r[0]=.4f;const float* in[]={l,r};
    check(queue.workerConfigure(mockModule,&g,0),"prepare worker");
    check(queue.rtSubmit(in,2,128),"submit old generation");
    check(queue.workerStep(),"old engine finished");
    check(queue.workerConfigure(mockModule,&g,0),"swap generation");
    float out[2]{};
    check(!queue.rtReadWet(4095,2,out),"stale generation output discarded");
    check(queue.stats().discardedWet==1,"stale output counted");
    g.fail=true;
    check(queue.rtSubmit(in,2,128),"submit faulty engine");
    check(queue.workerStep(),"fault reported to queue");
    check(!queue.rtReadWet(4223,2,out),"fault remains Dry");
    check(queue.stats().workerFailures==1,"worker fault accounted");

    check(!queue.workerConfigure(mockModule,&g,4096),
          "reject any module exceeding fixed 4095 PDC");
    g.fail=false;
    check(queue.workerConfigure(mockModule,&g,2047),
          "module latency 2047 accepted");
    queue.resetStopped(); // host stopped, no concurrent worker/RT
    check(queue.rtSubmit(in,2,128),"fresh timeline after stop");
    check(queue.workerStep(),"process 2047 latency module");
    check(!queue.rtReadWet(2047,2,out),"not before PDC-minus-module delay");
    check(queue.rtReadWet(2048,2,out),"precise 4095-2047 compensation");
    check(queue.rtHasPreparedWorker(),"plain reset preserved prepared engine");
    queue.detachWorkerWhenStopped(); // both simulated threads quiescent
    check(!queue.rtHasPreparedWorker(),"full stop detached worker callback");
    check(queue.rtNextTime()==0,"full stop clears source timeline");
}
static void boundedOverflow(){
    fw::AsyncPcmMailbox queue;
    GainContext ctx{};
    check(queue.workerConfigure(mockModule,&ctx,0),"prepare");
    float a[1]{.5f},b[1]{.5f};
    const float* in[]={a,b};
    for(uint32_t i=0;i<fw::AsyncPcmMailbox::kQueueSize;i++)
        check(queue.rtSubmit(in,2,1),"fill preallocated ingress");
    check(!queue.rtSubmit(in,2,1),"full ingress never blocks audio");
    check(queue.stats().rejectedInput==1,"drop counted");
    check(queue.rtNextTime()==fw::AsyncPcmMailbox::kQueueSize+1,
          "timeline still advances when dropping");
    for(uint32_t i=0;i<fw::AsyncPcmMailbox::kQueueSize;i++)
        check(queue.workerStep(),"worker drains ingress");
    check(!queue.workerStep(),"worker empty queue does not block");
}
int main(){
    deadlineAndAutomation();
    faultsAndGenerations();
    boundedOverflow();
    std::puts("PASS async PCM: 4095 PDC, sample offsets, faults, generation, overflow");
}
