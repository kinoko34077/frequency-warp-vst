#pragma once
// S3b3 preallocated audio <-> worker PCM transport. Audio thread NEVER calls
// Wasmi, touches an engine handle, allocates, waits, opens files or takes locks.
// A worker invokes the native Rust C ABI and returns generation-tagged f32 PCM.
// Fixed host PDC is 4095; late/missing/broken results become delayed Dry.
#include "native_engine_abi.h"
#include <array>
#include <atomic>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <limits>

namespace fw {
template<class T,uint32_t Capacity> class SpscPackets {
    static_assert(Capacity>1);
public:
    bool push(const T& packet) noexcept {
        const auto w=written_.load(std::memory_order_relaxed);
        const auto r=read_.load(std::memory_order_acquire);
        if(w-r>=Capacity)return false;
        slots_[w%Capacity]=packet;
        written_.store(w+1,std::memory_order_release);
        return true;
    }
    bool pop(T& result) noexcept {
        const auto r=read_.load(std::memory_order_relaxed);
        if(r==written_.load(std::memory_order_acquire))return false;
        result=slots_[r%Capacity];
        read_.store(r+1,std::memory_order_release);
        return true;
    }
    // Only valid after worker and RT have stopped using the queue.
    void resetStopped() noexcept {
        written_.store(0,std::memory_order_relaxed);
        read_.store(0,std::memory_order_relaxed);
    }
private:
    std::array<T,Capacity> slots_{};
    std::atomic<uint64_t> written_{0},read_{0};
};

class AsyncPcmMailbox {
public:
    static constexpr uint32_t kHostPdc=4095;
    static constexpr uint32_t kMaxFrames=128;
    static constexpr uint32_t kMaxEvents=128;
    static constexpr uint32_t kQueueSize=64;
    static_assert(std::atomic<uint64_t>::is_always_lock_free,
                  "64-bit timeline counters must be lock-free on x64");
    struct Input {
        uint64_t frame=0,generation=0;
        uint32_t frames=0,channels=0,eventCount=0;
        std::array<float,2*kMaxFrames> data{};
        std::array<FWNativeEvent,kMaxEvents> events{};
    };
    struct Output {
        uint64_t due=0,generation=0;
        uint32_t frames=0,channels=0;
        bool good=false;
        std::array<float,2*kMaxFrames> data{};
    };
    // Worker callback may execute Wasmi/allocate. NEVER invoke it on audio.
    using ProcessFn=int32_t (*)(void* context,const float* input,
        float* output,uint32_t frames,const FWNativeEvent* events,
        uint32_t count);
    struct Stats {uint64_t rejectedInput=0,rejectedOutput=0,workerFailures=0,
                  discardedWet=0;};

    // RT producer: one submission per contiguous chunk (<=128 frames).
    // Rejected chunks still advance the sample timeline; caller emits Dry.
    bool rtSubmit(const float* const* planar,uint32_t channels,uint32_t frames,
                  const FWNativeEvent* events=nullptr,uint32_t count=0) noexcept {
        const uint64_t start=nextInputTime_;
        if(frames>std::numeric_limits<uint64_t>::max()-nextInputTime_)return false;
        nextInputTime_+=frames;
        if(!(channels==1||channels==2)||frames>kMaxFrames||count>kMaxEvents||
           (frames>0&&!planar)||(count>0&&!events)) {
            rejectedInput_.fetch_add(1,std::memory_order_relaxed);return false;
        }
        Input job{};
        job.frame=start; job.frames=frames;job.channels=channels;job.eventCount=count;
        job.generation=activeGeneration_.load(std::memory_order_acquire);
        for(uint32_t c=0;c<channels;c++){
            if(frames&&!planar[c]){
                rejectedInput_.fetch_add(1,std::memory_order_relaxed);return false;
            }
            if(frames)std::memcpy(job.data.data()+c*frames,planar[c],frames*sizeof(float));
        }
        uint32_t prev=0;
        for(uint32_t e=0;e<count;e++){
            const auto& event=events[e];
            if(!std::isfinite(event.value)||event.offset<prev||
               (frames==0 ? event.offset!=0:event.offset>=frames)){
                rejectedInput_.fetch_add(1,std::memory_order_relaxed);return false;
            }
            prev=event.offset;job.events[e]=event;
        }
        if(!input_.push(job)){
            rejectedInput_.fetch_add(1,std::memory_order_relaxed);return false;
        }
        return true;
    }
    // Off-RT worker only, and only after preparing/validating native module.
    // Generation changes invalidate all old delayed wet packets at RT output;
    // no new package/file/engine is ever accessed from the audio callback.
    bool workerConfigure(ProcessFn process,void* context,uint32_t moduleLatency) noexcept {
        if(moduleLatency>kHostPdc)return false;
        workerProcess_=process;workerContext_=context;workerLatency_=moduleLatency;
        const auto next=activeGeneration_.load(std::memory_order_relaxed)+1;
        workerGeneration_=next;
        activeGeneration_.store(next,std::memory_order_release);
        workerReady_.store(process!=nullptr,std::memory_order_release);
        return true;
    }
    // Off-RT only. Process at most one queued block, bounded queue operations.
    // The selected callback may allocate or trap; its C FFI must catch failures.
    bool workerStep() {
        Input job{};
        if(!input_.pop(job))return false;
        if(job.generation!=workerGeneration_||!workerProcess_)return true;
        Output result{};
        result.due=job.frame+(kHostPdc-workerLatency_);
        result.generation=job.generation;
        result.frames=job.frames;result.channels=job.channels;
        const auto rc=workerProcess_(workerContext_,job.data.data(),result.data.data(),
              job.frames,job.events.data(),job.eventCount);
        result.good=rc==0;
        if(result.good) {
            for(uint32_t i=0;i<job.frames*job.channels;i++) {
                if(!std::isfinite(result.data[i])){result.good=false;break;}
            }
        }
        if(!result.good)workerFailures_.fetch_add(1,std::memory_order_relaxed);
        if(job.frames && !output_.push(result)){
            rejectedOutput_.fetch_add(1,std::memory_order_relaxed);
        }
        return true;
    }
    // RT consumer: read wet only if the *entire* chunk met its sample deadline.
    // Caller should emit the existing 4095-frame PDC-aligned Dry when false.
    bool rtReadWet(uint64_t now,uint32_t channels,float* wet) noexcept {
        if(!wet||!(channels==1||channels==2))return false;
        const auto generation=activeGeneration_.load(std::memory_order_acquire);
        for(uint32_t attempt=0;attempt<=kQueueSize;attempt++){
            if(!haveCurrent_) {
                if(!output_.pop(current_))return false;
                haveCurrent_=true;currentStarted_=false;
            }
            const auto& packet=current_;
            // Reject late chunks altogether: never splice half of a chunk
            // into the Dry fallback due to unpredictable worker scheduling.
            if(packet.generation!=generation||packet.channels!=channels||
               !packet.good||(!currentStarted_&&now>packet.due)||
               now>=packet.due+packet.frames){
                haveCurrent_=currentStarted_=false;
                discardedWet_.fetch_add(1,std::memory_order_relaxed);
                continue;
            }
            if(now<packet.due)return false;
            if(!currentStarted_&&now!=packet.due)return false;
            const auto pos=now-packet.due;
            for(uint32_t c=0;c<channels;c++)
                wet[c]=packet.data[c*packet.frames+static_cast<uint32_t>(pos)];
            currentStarted_=true;
            if(pos+1==packet.frames)haveCurrent_=currentStarted_=false;
            return true;
        }
        return false;
    }
    // Audio thread queries this only; worker enables after complete setup.
    // Must be reset by the owning plugin's non-RT lifecycle before destruction.
    bool rtHasPreparedWorker() const noexcept {
        return workerReady_.load(std::memory_order_acquire);
    }
    Stats stats() const noexcept {
        return {rejectedInput_.load(std::memory_order_relaxed),
                rejectedOutput_.load(std::memory_order_relaxed),
                workerFailures_.load(std::memory_order_relaxed),
                discardedWet_.load(std::memory_order_relaxed)};
    }
    uint64_t rtNextTime() const noexcept {return nextInputTime_;}
    // Called ONLY with audio and worker both quiescent.
    void resetStopped() noexcept {
        input_.resetStopped();output_.resetStopped();
        nextInputTime_=0;haveCurrent_=currentStarted_=false;
        current_=Output{};
        workerProcess_=nullptr;workerContext_=nullptr;workerLatency_=0;
        workerGeneration_=1;activeGeneration_.store(1,std::memory_order_relaxed);
        workerReady_.store(false,std::memory_order_release);
    }
private:
    SpscPackets<Input,kQueueSize> input_{};
    SpscPackets<Output,kQueueSize> output_{};
    uint64_t nextInputTime_=0; // RT-owned
    std::atomic<uint64_t> activeGeneration_{1};
    std::atomic<bool> workerReady_{false};
    uint64_t workerGeneration_=1; // worker-owned
    uint32_t workerLatency_=0;
    ProcessFn workerProcess_=nullptr;
    void* workerContext_=nullptr;
    Output current_{}; // RT-owned
    bool haveCurrent_=false,currentStarted_=false;
    std::atomic<uint64_t> rejectedInput_{0},rejectedOutput_{0},
                          workerFailures_{0},discardedWet_{0};
};
} // namespace fw
