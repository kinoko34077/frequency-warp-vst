#pragma once
// S3b2: RT-only handoff of opaque, already prepared engine instances.
// Deliberately does NOT execute the Rust WASM interpreter in the audio callback.
// All engine ownership belongs to worker: prepared objects are never created,
// destroyed, opened, or compiled in any rt* function.
//
// Single worker producer/collector, single audio consumer, including a caller
// guarantee that neither overlaps plugin teardown. A pointer is published
// exactly once; republishing an active/retired pointer is a caller error.
// All pointers must remain valid until the collector receives them. A module
// fault may revert to a still-live fading predecessor or to Dry fallback.
#include <atomic>
#include <cstdint>
#include <type_traits>

namespace fw {
template<class Engine> class RtEngineHandoff {
public:
    static_assert(std::atomic<Engine*>::is_always_lock_free,
                  "pointer atomics must be lock-free on the target audio host");

    // Worker only: transfer ownership *when the CAS succeeds*.
    // On rejection the caller still owns this prepared candidate.
    bool publish(Engine* candidate) noexcept {
        if(!candidate)return false;
        Engine* empty=nullptr;
        return pending_.compare_exchange_strong(
            empty,candidate,std::memory_order_release,std::memory_order_relaxed);
    }
    // Worker only: popped pointer is safe to dispose outside the RT thread.
    Engine* collectRetired() noexcept {
        return retired_.exchange(nullptr,std::memory_order_acq_rel);
    }
    // Worker only: inspect candidate occupancy, not the RT active pointer.
    bool hasPending() const noexcept {
        return pending_.load(std::memory_order_acquire)!=nullptr;
    }
    // Audio thread: begin one block. Hold the old engine until the bounded
    // fade ends; do not start a second switch until the collector takes it.
    bool rtBeginBlock(uint32_t fadeFrames,bool doubleEngineBudgetOk) noexcept {
        drainFaulted();
        if(faulted_ || oldFading_ ||
           retired_.load(std::memory_order_acquire)!=nullptr) return false;
        Engine* next=pending_.exchange(nullptr,std::memory_order_acq_rel);
        if(!next)return false;
        Engine* previous=active_;
        if(next==previous){return false;} // no duplicate retirement
        active_=next;
        if(previous) {
            if(doubleEngineBudgetOk&&fadeFrames>=2&&fadeFrames<=maxFadeFrames) {
                oldFading_=previous;
                fadeLength_=fadeFrames;
                fadeProgress_=0;
            }else{
                retired_.store(previous,std::memory_order_release);
            }
        }
        return true;
    }
    // Audio thread: current processing handle; nullptr means fixed-PDC Dry.
    Engine* rtActive() const noexcept {return faulted_?nullptr:active_;}
    Engine* rtFadeOut() const noexcept {return oldFading_;}
    bool rtInFade() const noexcept {return oldFading_!=nullptr;}
    // 0..1 ramp aligned per sample. Both input engines MUST carry identical
    // PDC and the caller must have provisioned a verified double-engine budget.
    double rtNewWeight() const noexcept {
        return oldFading_&&fadeLength_>1
            ? static_cast<double>(fadeProgress_)/static_cast<double>(fadeLength_-1)
            : 1.0;
    }
    double rtOldWeight() const noexcept {return 1.0-rtNewWeight();}
    // Audio thread: call exactly once for each actual output sample, not
    // once per channel. Zero-frame flush must not advance the transition.
    void rtAdvanceFrame() noexcept {
        if(!oldFading_)return;
        if(++fadeProgress_>=fadeLength_) {
            // Retired slot was known empty at rtBeginBlock; no other RT writer.
            retired_.store(oldFading_,std::memory_order_release);
            oldFading_=nullptr;
            fadeLength_=fadeProgress_=0;
        }
    }
    // Audio thread on runtime failure. Never free. If crossfade predecessor
    // still exists, roll back to it. Otherwise keep Dry active while waiting
    // for the worker to collect the faulted engine.
    void rtFaultActive() noexcept {
        if(!active_)return;
        if(oldFading_&&retired_.load(std::memory_order_acquire)==nullptr) {
            retired_.store(active_,std::memory_order_release);
            active_=oldFading_;
            oldFading_=nullptr; fadeLength_=fadeProgress_=0;
            faulted_=false;
        }else{
            faulted_=true; // rtActive() is nullptr: must render fixed-PDC Dry
            drainFaulted();
        }
    }
    // Called only after RT callback stopped and all worker accesses stopped.
    // Caller then owns pointers and is responsible for distinct destruction.
    struct StoppedPointers {
        Engine* active=nullptr;
        Engine* fading=nullptr;
        Engine* pending=nullptr;
        Engine* retired=nullptr;
    };
    StoppedPointers reclaimWhenStopped() noexcept {
        StoppedPointers snapshot{active_,oldFading_,
            pending_.exchange(nullptr,std::memory_order_acq_rel),
            retired_.exchange(nullptr,std::memory_order_acq_rel)};
        active_=oldFading_=nullptr;fadeLength_=fadeProgress_=0;faulted_=false;
        return snapshot;
    }
    static constexpr uint32_t maxFadeFrames=8192;
private:
    void drainFaulted() noexcept {
        if(faulted_&&active_&&!oldFading_&&
           retired_.load(std::memory_order_acquire)==nullptr) {
            retired_.store(active_,std::memory_order_release);
            active_=nullptr;
            faulted_=false;
        }
    }
    std::atomic<Engine*> pending_{nullptr};
    std::atomic<Engine*> retired_{nullptr};
    Engine* active_=nullptr; // exclusively touched by RT thread
    Engine* oldFading_=nullptr; // RT only
    uint32_t fadeLength_=0,fadeProgress_=0;
    bool faulted_=false; // RT only
};
} // namespace fw
