#pragma once
#include <atomic>
#include <algorithm>
#include <cstdint>
#include <utility>

// Single producer (non-audio control/worker thread) and single consumer (audio thread).
// Never invokes a destructor, lock, allocation, callback or host API in audio methods.
// All pointers represent objects FULLY prepared outside RT and destroyed only after
// takeRetired() or stopped-state draining on a non-RT thread.
// This is an ownership primitive; it does NOT certify WASM processing as RT safe.
namespace fw {
template<class Engine> class SwapMailbox {
public:
    struct Weights {float outgoing;float incoming;};
    SwapMailbox()=default;
    SwapMailbox(const SwapMailbox&)=delete;
    SwapMailbox& operator=(const SwapMailbox&)=delete;

    // Worker: ownership transfers to mailbox iff true; caller retains on failure.
    bool publish(Engine* prepared,std::uint32_t fadeFrames) noexcept {
        if(!prepared||transition_.load(std::memory_order_acquire)||
           retired_.load(std::memory_order_acquire)||
           pending_.load(std::memory_order_acquire))return false;
        requestedFade_.store(fadeFrames,std::memory_order_relaxed);
        Engine* empty=nullptr;
        return pending_.compare_exchange_strong(empty,prepared,
                   std::memory_order_release,std::memory_order_relaxed);
    }

    // Audio thread: at block start, switch only when previous retirement cleared.
    void beginBlock() noexcept {
        if(transition_.load(std::memory_order_relaxed)||
           retired_.load(std::memory_order_acquire))return;
        // Handle a previously faulted active instance after worker has
        // emptied the retirement mailbox. Audio never destroys instances.
        if(faulted_) {
            if(active_)retired_.store(std::exchange(active_,nullptr),
                                      std::memory_order_release);
            faulted_=false;
            return;
        }
        if(!pending_.load(std::memory_order_acquire))return;
        transition_.store(true,std::memory_order_release);
        Engine* next=pending_.exchange(nullptr,std::memory_order_acq_rel);
        if(!next){transition_.store(false,std::memory_order_release);return;}
        outgoing_=std::exchange(active_,next);
        fadeTotal_=outgoing_?requestedFade_.load(std::memory_order_relaxed):0;
        fadeDone_=0;
        if(fadeTotal_==0)finishFade();
    }

    // Audio thread: accessor for prepared engines, never transfers ownership.
    Engine* active() const noexcept {return faulted_?nullptr:active_;}
    Engine* outgoing() const noexcept {return outgoing_;}
    bool switching() const noexcept {return outgoing_&&fadeTotal_>0;}

    Weights weightsAt(std::uint32_t sampleInBlock) const noexcept {
        if(!switching())return {0.f,1.f};
        const auto progress=std::min<std::uint64_t>(
            std::uint64_t(fadeDone_)+sampleInBlock,fadeTotal_);
        const float newer=static_cast<float>(
            static_cast<double>(progress)/static_cast<double>(fadeTotal_));
        return {1.f-newer,newer};
    }
    void finishFrames(std::uint32_t renderedFrames) noexcept {
        if(!switching())return;
        const auto remain=fadeTotal_-fadeDone_;
        fadeDone_+=std::min<std::uint64_t>(renderedFrames,remain);
        if(fadeDone_>=fadeTotal_)finishFade();
    }

    // Audio: faulty incoming engine reverts to previous one during fade.
    // If no previous engine exists, audio must emit PDC-aligned Dry/Silence.
    void reportActiveFault() noexcept {
        if(outgoing_) {
            Engine* failed=std::exchange(active_,outgoing_);
            outgoing_=nullptr;
            fadeDone_=fadeTotal_=0;
            retired_.store(failed,std::memory_order_release);
            transition_.store(false,std::memory_order_release);
            faulted_=false;
            return;
        }
        if(retired_.load(std::memory_order_acquire)) {
            faulted_=true; // Delay retirement; do not overwrite older pointer.
            return;
        }
        if(active_)retired_.store(std::exchange(active_,nullptr),
                                  std::memory_order_release);
        faulted_=false;
        transition_.store(false,std::memory_order_release);
    }

    // Non-RT worker: caller MUST destroy returned instance outside audio thread.
    Engine* takeRetired() noexcept {
        return retired_.exchange(nullptr,std::memory_order_acq_rel);
    }
    bool busy() const noexcept {
        return pending_.load(std::memory_order_acquire)||
            retired_.load(std::memory_order_acquire)||
            transition_.load(std::memory_order_acquire);
    }
    // Non-RT worker only when host has stopped ALL process callbacks.
    // Returns raw pointers to retire, never frees them.
    struct Stopped {Engine* active;Engine* outgoing;Engine* pending;Engine* retired;};
    Stopped drainStopped() noexcept {
        auto result=Stopped{active_,outgoing_,
            pending_.exchange(nullptr,std::memory_order_acq_rel),
            retired_.exchange(nullptr,std::memory_order_acq_rel)};
        active_=outgoing_=nullptr;
        fadeTotal_=fadeDone_=0;
        faulted_=false;
        transition_.store(false,std::memory_order_release);
        return result;
    }
private:
    void finishFade() noexcept {
        if(outgoing_)retired_.store(std::exchange(outgoing_,nullptr),
                                    std::memory_order_release);
        fadeTotal_=fadeDone_=0;
        transition_.store(false,std::memory_order_release);
    }
    std::atomic<Engine*> pending_{nullptr};
    std::atomic<Engine*> retired_{nullptr};
    std::atomic<std::uint32_t> requestedFade_{0};
    std::atomic<bool> transition_{false};
    // Consumer-owned state; never accessed concurrently from control thread.
    Engine* active_=nullptr;
    Engine* outgoing_=nullptr;
    std::uint64_t fadeTotal_=0,fadeDone_=0;
    bool faulted_=false;
};
} // namespace fw
