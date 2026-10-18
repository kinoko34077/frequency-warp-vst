#pragma once
// UI-5B2A: portable NON-RT preparation/handshake/rollback bookkeeping.
// Never navigates a WebView, grants DAW edit permission, reads mutable assets
// or trusts browser-provided version/origin as authority.
// Caller must verify *native* local origin, exact snapshot identity, and
// bridge handshake, then send a correlated acknowledgement to this object.
#include "ui_asset_snapshot.h"
#include <cstdint>
#include <memory>

namespace fw::ui_assets {
class UiActivationTransaction final {
public:
    using Snapshot=std::shared_ptr<const PinnedSnapshot>;
    enum class Phase { Idle, Prepared, AwaitingHandshake };
    enum class Intent { NewCandidate, Back };
    Phase phase() const noexcept {return phase_;}
    std::uint64_t pendingGeneration() const noexcept {
        return phase_==Phase::AwaitingHandshake?generation_:0;
    }
    const Snapshot& active() const noexcept {return active_;}
    const Snapshot& previous() const noexcept {return previous_;}
    const Snapshot& pending() const noexcept {return pending_;}
    Intent pendingIntent() const noexcept {return intent_;}

    // Preflight signature/version/byte attestation is already complete by
    // stagePinnedCandidate and its caller-trusted manifest; this class only
    // manages lifetimes and handshake correlation.
    bool prepare(const Snapshot& candidate) noexcept {
        if(phase_==Phase::AwaitingHandshake||
           !candidate||candidate->version!=1||candidate->files.empty()||
           candidate==active_)return false;
        pending_=candidate;
        phase_=Phase::Prepared;
        intent_=Intent::NewCandidate;
        return true;
    }
    bool prepareBack() noexcept {
        if(phase_==Phase::AwaitingHandshake||
           !previous_||previous_==active_)return false;
        pending_=previous_;
        phase_=Phase::Prepared;
        intent_=Intent::Back;
        return true;
    }
    // Generation is owned by native shell, not supplied by the web page.
    // The separate explicitUserIntent check must originate from an OS/user
    // action in the later native integration, never raw JS metadata.
    std::uint64_t begin(bool explicitUserIntent) noexcept {
        if(!explicitUserIntent||phase_!=Phase::Prepared||!pending_||
           generation_==UINT64_MAX)return 0;
        ++generation_;
        phase_=Phase::AwaitingHandshake;
        return generation_;
    }
    // Both flags must be independently observed by trusted native integration.
    // A JavaScript "hello" on its own is NOT an approval.
    bool accept(std::uint64_t generation,std::uint32_t candidateVersion,
                bool nativeOriginVerified,bool bridgeHandshakeVerified) noexcept {
        if(phase_!=Phase::AwaitingHandshake||
           generation==0||generation!=generation_||!pending_||
           candidateVersion!=pending_->version||
           !nativeOriginVerified||!bridgeHandshakeVerified)return false;
        // The still-pinned active UI is unchanged until *this* final commit.
        const auto newActive=pending_;
        const auto prior=active_;
        active_=newActive;
        previous_=prior;
        pending_.reset();
        phase_=Phase::Idle;
        return true;
    }
    // Error/timeout/navigation failure on a correlated pending generation
    // must preserve the last-good active UI, including on repeated failure.
    bool fail(std::uint64_t generation) noexcept {
        if(phase_!=Phase::AwaitingHandshake||
           generation==0||generation!=generation_)return false;
        pending_.reset();
        phase_=Phase::Idle;
        return true;
    }
    void cancel() noexcept {
        pending_.reset();
        phase_=Phase::Idle;
    }
    // A view teardown cancels pending transactions but retains the already
    // pinned current and Back target until the owning host also goes away.
    void editorDetached() noexcept {cancel();}
private:
    Phase phase_=Phase::Idle;
    Intent intent_=Intent::NewCandidate;
    std::uint64_t generation_=0;
    Snapshot active_{},previous_{},pending_{};
};
} // namespace fw::ui_assets
