#pragma once
// R3C2C1: bounded non-RT -> RT authorization publication. No native Wasmi
// handle, descriptor JSON, mutex, heap allocation, or Javascript reaches RT.
// A published snapshot is only usable while its unique atomic ticket is live.
// Worker load/clear/fault MUST revoke before changing the active engine.
#include "async_pcm_mailbox.h"
#include "generic_authorization_plan.h"
#include "generic_numeric_codec.h"
#include <array>
#include <atomic>
#include <cstdint>
#include <limits>
#include <type_traits>

namespace fw {
struct GenericAuthorizationSnapshot {
    std::uint64_t allowedMask=0;
    std::uint64_t acceptedGeneration=0;
    std::array<std::uint8_t,32> verifiedPackageSha256{};
    // Authored by the verified WASM module, never copied from UI JSON.
    std::array<FWNativeGenericCodec,64> codec{};
    std::uint64_t ticket=0;
};
static_assert(std::is_trivially_copyable<GenericAuthorizationSnapshot>::value,
              "RT authorization packets must contain POD only");

// Worker-only: caller must have built 'plan' on the SAME still-live native
// Wasmi handle, after matching FWS3 project package/ledger, descriptor and
// worker generation. readCodec must call fw_native_copy_generic_codec on that
// exact handle, not on a new or guessed instance. This is an additive proof;
// it does not by itself publish host automation.
template<class ReadCodec>
bool buildGenericAuthorizationSnapshot(const GenericAuthorizationPlan& plan,
                                       ReadCodec&& readCodec,
                                       GenericAuthorizationSnapshot& out) {
    if(!plan.allowedMask || !plan.acceptedGeneration) return false;
    GenericAuthorizationSnapshot candidate{};
    candidate.allowedMask=plan.allowedMask;
    candidate.acceptedGeneration=plan.acceptedGeneration;
    candidate.verifiedPackageSha256=plan.verifiedPackageSha256;
    for(std::uint32_t slot=64;slot<=127;++slot) {
        const std::uint64_t bit=std::uint64_t{1}<<(slot-64);
        if(!(plan.allowedMask&bit))continue;
        FWNativeGenericCodec value{};
        bool success=false;
        try {success=readCodec(slot,value);}
        catch(...) {return false;}
        if(!success || value.hostSlot!=slot || value.codecRevision!=1 ||
           value.scale>4)return false;
        GenericNumericCodec check{};
        check.hostSlot=slot;
        check.codecRevision=value.codecRevision;
        check.scale=static_cast<GenericScale>(value.scale);
        check.min=value.min;check.max=value.max;
        check.def=value.defaultValue;check.steps=value.steps;
        if(!validGenericNumericCodec(check))return false;
        candidate.codec[slot-64]=value;
    }
    out=candidate;
    return true;
}

class GenericAuthorizationMailbox final {
public:
    GenericAuthorizationMailbox()=default;
    GenericAuthorizationMailbox(const GenericAuthorizationMailbox&)=delete;
    GenericAuthorizationMailbox& operator=(const GenericAuthorizationMailbox&)=delete;
    // Worker-only. Immediate fail-closed gate, including queued old packets.
    void workerRevoke() noexcept {
        activeTicket_.store(0,std::memory_order_release);
    }
    // Worker-only. An unsuccessful update never enables stale permission.
    // Check exact current worker identity again at the commit boundary.
    bool workerPublish(const GenericAuthorizationSnapshot& snapshot,
                       std::uint64_t currentGeneration,
                       const std::array<std::uint8_t,32>& currentSha) noexcept {
        workerRevoke();
        if(!snapshot.allowedMask || !snapshot.acceptedGeneration ||
           snapshot.acceptedGeneration!=currentGeneration ||
           snapshot.verifiedPackageSha256!=currentSha ||
           nextTicket_==std::numeric_limits<std::uint64_t>::max())
            return false;
        for(std::uint32_t slot=64;slot<=127;slot++){
            if(!(snapshot.allowedMask&(std::uint64_t{1}<<(slot-64))))continue;
            const auto& value=snapshot.codec[slot-64];
            if(value.hostSlot!=slot || value.codecRevision!=1 || value.scale>4)
                return false;
            GenericNumericCodec check{};
            check.hostSlot=slot;check.codecRevision=value.codecRevision;
            check.scale=static_cast<GenericScale>(value.scale);
            check.min=value.min;check.max=value.max;
            check.def=value.defaultValue;check.steps=value.steps;
            if(!validGenericNumericCodec(check))return false;
        }
        auto proposed=snapshot;
        proposed.ticket=++nextTicket_;
        if(!queue_.push(proposed))return false;
        activeTicket_.store(proposed.ticket,std::memory_order_release);
        return true;
    }
    // Audio thread: bounded FIFO drain at most once per process callback.
    // Only reads fixed-size packets and lock-free atomics.
    void rtAdopt() noexcept {
        GenericAuthorizationSnapshot next{};
        for(unsigned i=0;i<kCapacity && queue_.pop(next);++i)
            rtOwned_=next;
    }
    bool rtAllows(std::uint32_t slot,std::uint64_t generation,
                  const std::array<std::uint8_t,32>& sha) const noexcept {
        if(slot<64||slot>127 || !rtOwned_.ticket ||
           !rtOwned_.acceptedGeneration ||
           rtOwned_.acceptedGeneration!=generation ||
           rtOwned_.verifiedPackageSha256!=sha ||
           !(rtOwned_.allowedMask&(std::uint64_t{1}<<(slot-64))))
            return false;
        return activeTicket_.load(std::memory_order_acquire)==rtOwned_.ticket;
    }
    const FWNativeGenericCodec* rtCodec(std::uint32_t slot,
                  std::uint64_t generation,
                  const std::array<std::uint8_t,32>& sha) const noexcept {
        return rtAllows(slot,generation,sha)?&rtOwned_.codec[slot-64]:nullptr;
    }
    // Requires quiesced producer and consumer; avoids instance reuse.
    void resetStopped() noexcept {
        workerRevoke();
        queue_.resetStopped();
        rtOwned_=GenericAuthorizationSnapshot{};
    }
private:
    static constexpr unsigned kCapacity=4;
    SpscPackets<GenericAuthorizationSnapshot,kCapacity> queue_{};
    std::atomic<std::uint64_t> activeTicket_{0};
    std::uint64_t nextTicket_=0; // worker-owned only, never reset/reused
    GenericAuthorizationSnapshot rtOwned_{}; // audio-owned only
};
} // namespace fw
