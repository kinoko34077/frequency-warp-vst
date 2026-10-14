#include "../src/rt_engine_handoff.h"
#include <atomic>
#include <array>
#include <thread>
#include <cstdio>
#include <cstdlib>
#include <cmath>
using fw::RtEngineHandoff;
struct Engine { int id; };
static void check(bool ok,const char* why) {
    if(!ok) {std::fprintf(stderr,"rt handoff FAIL: %s\n",why);std::abort();}
}
static void transitionAndFaults() {
    RtEngineHandoff<Engine> queue;
    Engine a{1},b{2},c{3},d{4},e{5};
    check(queue.rtActive()==nullptr,"initial Dry");
    check(!queue.rtBeginBlock(2,true),"empty proposal rejected");
    check(!queue.publish(nullptr),"null proposal rejected");
    check(queue.publish(&a),"prepare a");
    check(!queue.publish(&b),"second concurrent pending candidate rejected");
    check(queue.rtBeginBlock(128,true),"activate a");
    check(queue.rtActive()==&a,"active a");
    check(queue.collectRetired()==nullptr,"no first retirement");
    check(queue.publish(&b),"prepare b");
    check(queue.rtBeginBlock(4,true),"start four-frame crossfade");
    check(queue.rtInFade()&&queue.rtFadeOut()==&a&&queue.rtActive()==&b,
          "old held, new active");
    for(unsigned sample=0;sample<4;sample++) {
        check(std::abs(queue.rtNewWeight()-sample/3.0)<1.e-12,
              "per-frame bounded ramp with both endpoints");
        check(std::abs(queue.rtOldWeight()+queue.rtNewWeight()-1.)<1.e-12,
              "complementary weights");
        check(!queue.rtBeginBlock(4,true),"reject switch while crossfading");
        queue.rtAdvanceFrame();
    }
    check(!queue.rtInFade(),"crossfade retired on completion");
    check(queue.collectRetired()==&a,"old engine retired on worker only");
    check(queue.collectRetired()==nullptr,"no double retirement");

    check(queue.publish(&c),"prepare c");
    check(queue.rtBeginBlock(4,false),"budget denial chooses hard switch");
    check(!queue.rtInFade()&&queue.rtActive()==&c,"hard switch active c");
    check(queue.publish(&d),"prepare d despite pending retire");
    check(!queue.rtBeginBlock(4,true),"retire queue backpressure prevents overwrite");
    check(queue.hasPending(),"unconsumed candidate d stays pending");
    check(queue.collectRetired()==&b,"old b reclaimed");
    check(queue.rtBeginBlock(10,true),"c->d fade begins");
    queue.rtAdvanceFrame();
    queue.rtFaultActive(); // Fail new d while c still valid: rollback.
    check(queue.rtActive()==&c&&!queue.rtInFade(),"fault rollback old c");
    check(queue.collectRetired()==&d,"faulted d retired once");
    check(queue.collectRetired()==nullptr,"no duplicate retired d");

    queue.rtFaultActive(); // No predecessor: fixed-PDC Dry.
    check(queue.rtActive()==nullptr,"fault falls back to Dry");
    check(queue.collectRetired()==&c,"faulted c goes to worker");
    check(queue.publish(&e),"fresh module e after fault");
    check(queue.rtBeginBlock(2,true),"restore e from Dry");
    check(queue.rtActive()==&e,"restored active e");
    const auto stopped=queue.reclaimWhenStopped();
    check(stopped.active==&e&&!stopped.fading&&!stopped.pending&&!stopped.retired,
          "stopped ownership drains safely");
    check(queue.rtActive()==nullptr,"no active pointer after teardown");
}
// Immutable test engines make the producer/consumer timing race visible
// without risking an actual use-after-free in a test.
static void stressSingleProducerSingleConsumer() {
    constexpr int N=1200;
    std::array<Engine,N> engines{};
    for(int i=0;i<N;i++)engines[i].id=i;
    RtEngineHandoff<Engine> queue;
    std::atomic<bool> producerDone{false};
    std::atomic<int> retiredCount{0};
    std::array<std::atomic<int>,N> retired{};
    for(auto& item:retired)item.store(0);
    std::thread producer([&] {
        for(int i=0;i<N;i++) {
            while(!queue.publish(&engines[i])) {
                if(Engine* old=queue.collectRetired()) {
                    check(old->id>=0&&old->id<N,"retired pointer intact");
                    retired[old->id].fetch_add(1);
                    retiredCount.fetch_add(1);
                }
                std::this_thread::yield();
            }
        }
        producerDone.store(true,std::memory_order_release);
        // RT can still publish last retirement; drain until terminated by main.
    });
    int switches=0;
    while(!producerDone.load(std::memory_order_acquire)||queue.hasPending()) {
        if(queue.rtBeginBlock(0,false))switches++;
        if(Engine* old=queue.collectRetired()) {
            retired[old->id].fetch_add(1);
            retiredCount.fetch_add(1);
        }
        std::this_thread::yield();
    }
    producer.join();
    if(Engine* old=queue.collectRetired()) {
        retired[old->id].fetch_add(1);retiredCount.fetch_add(1);
    }
    auto owners=queue.reclaimWhenStopped();
    check(!owners.pending&&!owners.fading&&!owners.retired,"stopped clean");
    check(owners.active!=nullptr,"latest active retained");
    check(switches>=1,"switching occurred");
    for(int i=0;i<N;i++) {
        const int count=retired[i].load()+(owners.active==&engines[i]?1:0);
        // A pending proposal may be delayed but cannot be lost. We only
        // guarantee no duplicate lifetime release for any retired engine.
        check(count<=1,"at-most-once engine lifetime");
    }
    check(retiredCount.load()+1<=N,"retirement count bounded");
}
int main() {
    static_assert(RtEngineHandoff<Engine>::maxFadeFrames==8192);
    transitionAndFaults();
    stressSingleProducerSingleConsumer();
    std::puts("PASS: bounded lock-free block switch, fade, rollback, off-RT retirement");
}
