#include "../../src/parameter_state_mailbox.h"
#include <array>
#include <atomic>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <thread>
using Values=std::array<double,128>;
static void check(bool ok,const char* reason){
    if(!ok){std::fprintf(stderr,"FAIL state mailbox: %s\n",reason);std::abort();}
}
int main(){
    Values defaults{};
    defaults.fill(.5);
    fw::ParameterStateMailbox<128> mail(defaults);
    Values ui{};
    check(mail.uiSnapshot(ui)&&ui==defaults,"initial DAW snapshot");

    // Host project load before the audio callback must be captured atomically.
    Values audio=defaults,first=defaults;
    first[0]=first[1]=first[2]=first[3]=.25;
    mail.uiStage(first);
    check(mail.uiSnapshot(ui)&&ui==first,"staged project save before process");
    check(mail.rtAdopt(audio)&&audio==first,"project commit at process start");
    // Simulate DAW automation on a separate ID in the processing callback.
    audio[42]=.875;
    mail.rtPublish(audio);
    check(mail.uiSnapshot(ui)&&ui==audio,"audio automation published for save");
    check(!mail.rtAdopt(audio),"same UI image applied more than once");

    // Simulate VST3 getState UI callbacks overlapping many RT callbacks and
    // setState staging. Every commit is one coherent 128-slot transaction.
    std::atomic<bool> done{false},failed{false};
    std::atomic<unsigned> readCount{0},adoptCount{0};
    std::thread processing([&]{
        Values local=audio;
        while(!done.load(std::memory_order_acquire)){
            if(mail.rtAdopt(local)){
                if(local[0]!=local[1]||local[1]!=local[2]||
                   local[2]!=local[3])failed.store(true,std::memory_order_release);
                adoptCount.fetch_add(1,std::memory_order_relaxed);
            }
            // Ordinary host automation must not mutate the UI stage.
            local[70]=.5;
            mail.rtPublish(local);
        }
    });
    for(unsigned n=0;n<10000;n++){
        Values candidate=first;
        candidate[0]=candidate[1]=candidate[2]=candidate[3]=
            static_cast<double>(n%997)/1000.;
        candidate[7]=static_cast<double>(n%13)/16.;
        mail.uiStage(candidate);
        Values snap{};
        if(mail.uiSnapshot(snap)){
            check(snap[0]==snap[1]&&snap[1]==snap[2]&&snap[2]==snap[3],
                  "partial UI stage or partial RT publish leaked to DAW");
            readCount.fetch_add(1,std::memory_order_relaxed);
        }
    }
    done.store(true,std::memory_order_release);
    processing.join();
    check(!failed.load(std::memory_order_acquire),"RT observed torn project transaction");
    check(readCount.load()>0,"UI could not read any coherent state");

    // Once RT finishes the last staged state, the next DAW save must reflect
    // that same project plus subsequent realtime automation.
    Values terminal=defaults;
    terminal[0]=terminal[1]=terminal[2]=terminal[3]=.333;
    mail.uiStage(terminal);
    Values final{};
    check(mail.rtAdopt(final)&&final==terminal,"last state not adopted after audio quiet");
    mail.rtPublish(final);
    check(mail.uiSnapshot(ui)&&ui==final,"last coherent project not persisted");
    std::printf("PASS bounded lock-free VST3 UI/RT state mailbox, %u UI saves %u RT stage commits\n",
                readCount.load(),adoptCount.load());
    return 0;
}
