// S3b2 concurrent lifetime stress against the ALREADY MERGED SwapMailbox.
// This is intentionally a separate test: do not add a competing RT switcher.
#include "../../src/rt_swap_mailbox.h"
#include <array>
#include <atomic>
#include <chrono>
#include <cstdlib>
#include <cstdio>
#include <thread>

static void check(bool value,const char* why) {
    if(!value){std::fprintf(stderr,"swap stress failure: %s\n",why);std::abort();}
}
struct Engine {int id;};

static void exercise(unsigned fadeFrames) {
    constexpr int N=1600;
    std::array<Engine,N> fixtures{};
    std::array<std::atomic<int>,N> released{};
    for(int i=0;i<N;i++){fixtures[i].id=i;released[i].store(0);}
    fw::SwapMailbox<Engine> box;
    std::atomic<bool> publishedAll{false},stopCollector{false};
    std::atomic<int> retireCount{0};

    // Dedicated non-RT producer and collector. Instances are never destroyed
    // in this test until both threads have stopped; validates at-most-once.
    std::thread worker([&](){
        auto collect=[&](){
            if(Engine* retired=box.takeRetired()) {
                check(retired->id>=0&&retired->id<N,"retired engine provenance");
                check(released[retired->id].fetch_add(1)==0,
                      "retired pointer delivered twice");
                retireCount.fetch_add(1);
            }
        };
        for(int i=0;i<N;i++) {
            while(!box.publish(&fixtures[i],fadeFrames)) {
                collect();
                std::this_thread::yield();
            }
        }
        publishedAll.store(true,std::memory_order_release);
        while(!stopCollector.load(std::memory_order_acquire)){
            collect();
            std::this_thread::yield();
        }
        collect();
    });

    Engine* previous=nullptr;
    int distinctActive=0;
    const auto started=std::chrono::steady_clock::now();
    while(!publishedAll.load(std::memory_order_acquire)||box.busy()) {
        box.beginBlock();
        if(box.active()!=previous){
            previous=box.active();
            if(previous)distinctActive++;
        }
        if(box.switching()){
            const auto weights=box.weightsAt(fadeFrames/2);
            check(weights.incoming>=0.f&&weights.incoming<=1.f,
                  "fade weight bound");
            check(weights.outgoing>=0.f&&weights.outgoing<=1.f,
                  "old fade weight bound");
        }
        box.finishFrames(fadeFrames>0?fadeFrames:64);
        check(std::chrono::steady_clock::now()-started<std::chrono::seconds(15),
              "publisher/consumer deadlock");
        std::this_thread::yield();
    }
    stopCollector.store(true,std::memory_order_release);
    worker.join();
    auto stopped=box.drainStopped();
    check(stopped.pending==nullptr&&stopped.outgoing==nullptr&&
          stopped.retired==nullptr,"no outstanding pointer on stopped drain");
    check(stopped.active==&fixtures[N-1],"last published must be active");
    check(distinctActive>0,"RT consumer observed engine");
    check(retireCount.load()==N-1,"every old engine retired exactly once");
    for(int i=0;i<N;i++){
        check(released[i].load()==(i==N-1?0:1),
              "all retired engines delivered once, newest still active");
    }
}
int main(){
    exercise(0); // hard switch
    exercise(32); // concurrent 32-frame crossfade and worker retire
    std::puts("PASS: concurrent prepared pointer publication, fade, lifetime and off-RT retirement");
}
