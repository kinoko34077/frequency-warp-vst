#pragma once
// R3C2D8C: non-RT native editor bookkeeping for explicit new FWS3 binding.
// This is only a UI state machine, never an authorization or state write.
// Worker/Saved FWS3 remain the sole authority for any DAW edit.
#include <cstdint>
namespace fw {
struct NewBindingStatus {
    std::uint64_t preparedRequest=0;
    std::uint64_t committedRequest=0;
    bool prepared=false;
    bool committed=false;
    bool saved=false;
    bool active=false;
};
class NativeBindingFlow final {
public:
    enum class Phase { Idle, Preparing, NeedsConfirmation, Committing, Accepted, Rejected };
    Phase phase() const noexcept {return phase_;}
    std::uint64_t request() const noexcept {return request_;}
    bool begin(std::uint64_t request) noexcept {
        if(request==0||phase_==Phase::Preparing||phase_==Phase::NeedsConfirmation||
           phase_==Phase::Committing)return false;
        request_=request;phase_=Phase::Preparing;return true;
    }
    bool canConfirm() const noexcept {return phase_==Phase::NeedsConfirmation;}
    bool confirmQueued() noexcept {
        if(!canConfirm())return false;
        phase_=Phase::Committing;return true;
    }
    // Ignore old/replayed replies and never treat mere worker preparation
    // as a committed, currently authorized saved FWS3 project.
    bool observe(const NewBindingStatus& state) noexcept {
        if(request_==0)return false;
        if(phase_==Phase::Preparing &&
           state.preparedRequest==request_) {
            phase_=state.prepared?Phase::NeedsConfirmation:Phase::Rejected;
            return true;
        }
        if(phase_==Phase::Committing &&
           state.committedRequest==request_) {
            if(!state.committed) {
                phase_=Phase::Rejected;return true;
            }
            if(state.saved && state.active) {
                phase_=Phase::Accepted;return true;
            }
        }
        return false;
    }
    void invalidate() noexcept {request_=0;phase_=Phase::Idle;}
private:
    std::uint64_t request_=0;
    Phase phase_=Phase::Idle;
};
} // namespace fw
