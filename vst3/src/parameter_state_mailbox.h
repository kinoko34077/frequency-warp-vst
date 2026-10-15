#pragma once
// S4c2: lock-free 128-slot handoff between the VST3 UI lifecycle thread and
// audio callback. UI never reads/writes the audio-owned parameter array.
// RT work is fixed and bounded: one 128-slot snapshot at most per process().
#include <array>
#include <atomic>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <type_traits>

namespace fw {

template<std::size_t N>
class ParameterStateMailbox final {
public:
    using Values=std::array<double,N>;
    static_assert(sizeof(double)==sizeof(std::uint64_t),"binary64 required");
    static_assert(std::atomic<std::uint64_t>::is_always_lock_free,
                  "RT mailbox needs lock-free 64-bit atomics");

    explicit ParameterStateMailbox(const Values& initial) noexcept {
        for(std::size_t i=0;i<N;i++) {
            const auto bits=toBits(initial[i]);
            staged_[i].store(bits,std::memory_order_seq_cst);
            published_[i].store(bits,std::memory_order_seq_cst);
        }
    }
    ParameterStateMailbox(const ParameterStateMailbox&)=delete;
    ParameterStateMailbox& operator=(const ParameterStateMailbox&)=delete;

    // One host/UI writer. Publish the entire decoded setState transaction;
    // never change audio-owned values from the UI thread.
    void uiStage(const Values& values) noexcept {
        stagedSeq_.fetch_add(1,std::memory_order_seq_cst); // odd: writer active
        for(std::size_t i=0;i<N;i++)
            staged_[i].store(toBits(values[i]),std::memory_order_seq_cst);
        stagedSeq_.fetch_add(1,std::memory_order_seq_cst); // even: committed
    }

    // Called ONCE at the start of process(), including zero-frame flush.
    // No spinning, mutex, heap, blocking, or work proportional to host events.
    // On concurrent UI write the entire stage is deferred to next callback.
    bool rtAdopt(Values& audioOwned) noexcept {
        const auto before=stagedSeq_.load(std::memory_order_seq_cst);
        if((before&1u)||before==rtAdopted_)return false;
        Values next{};
        for(std::size_t i=0;i<N;i++)
            next[i]=fromBits(staged_[i].load(std::memory_order_seq_cst));
        if(stagedSeq_.load(std::memory_order_seq_cst)!=before)return false;
        audioOwned=next;
        rtAdopted_=before;
        return true;
    }

    // Called once after successful audio processing; whole-frame state may
    // include host automation after the UI's latest setState.
    void rtPublish(const Values& audioOwned) noexcept {
        publishedSeq_.fetch_add(1,std::memory_order_seq_cst); // odd
        for(std::size_t i=0;i<N;i++)
            published_[i].store(toBits(audioOwned[i]),std::memory_order_seq_cst);
        publishedSeq_.fetch_add(1,std::memory_order_seq_cst); // even
        rtFinishedStage_.store(rtAdopted_,std::memory_order_seq_cst);
    }

    // UI only. Prefer a newly staged (not yet audio-adopted) project image;
    // otherwise take the last coherent RT snapshot. Fail rather than emit a
    // torn DAW project when the audio thread changes values continuously.
    bool uiSnapshot(Values& result) const noexcept {
        for(unsigned retry=0;retry<64;retry++) {
            const auto requested=stagedSeq_.load(std::memory_order_seq_cst);
            const auto finished=rtFinishedStage_.load(std::memory_order_seq_cst);
            if(requested>finished) {
                if(readStable(staged_,stagedSeq_,result))return true;
            }else if(readStable(published_,publishedSeq_,result)) {
                // UI may have staged another transaction during this read.
                if(stagedSeq_.load(std::memory_order_seq_cst)<=
                   rtFinishedStage_.load(std::memory_order_seq_cst))
                    return true;
            }
        }
        return false;
    }

private:
    using AtomicValues=std::array<std::atomic<std::uint64_t>,N>;
    static std::uint64_t toBits(double value) noexcept {
        std::uint64_t bits=0;std::memcpy(&bits,&value,sizeof(bits));return bits;
    }
    static double fromBits(std::uint64_t bits) noexcept {
        double value=0;std::memcpy(&value,&bits,sizeof(value));return value;
    }
    static bool readStable(const AtomicValues& cells,
                           const std::atomic<std::uint64_t>& seq,
                           Values& result) noexcept {
        const auto before=seq.load(std::memory_order_seq_cst);
        if(before&1u)return false;
        Values next{};
        for(std::size_t i=0;i<N;i++)
            next[i]=fromBits(cells[i].load(std::memory_order_seq_cst));
        if(before!=seq.load(std::memory_order_seq_cst))return false;
        result=next;
        return true;
    }
    AtomicValues staged_{};
    AtomicValues published_{};
    std::atomic<std::uint64_t> stagedSeq_{0};
    std::atomic<std::uint64_t> publishedSeq_{0};
    std::atomic<std::uint64_t> rtFinishedStage_{0};
    std::uint64_t rtAdopted_=0; // audio-thread-owned; never observed by UI
};

} // namespace fw
