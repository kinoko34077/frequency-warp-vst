#pragma once
// S3b4-B: plugin-owned NON-AUDIO worker. Only this thread calls the Rust
// native Wasmi C ABI. All mailbox RT methods stay allocation-free.
// No file picker/DAW controller yet; UI will call postPackage() off RT.
#include "async_pcm_mailbox.h"
#include "stream_host_events.h"
#include "native_engine_abi.h"
#include "generic_authorization_mailbox.h"
#include "verified_generic_ledger_candidate.h"
#include <array>
#include <atomic>
#include <chrono>
#include <cstdint>
#include <mutex>
#include <string>
#include <thread>
#include <utility>
#include <vector>

namespace fw {
class NativeWorkerService final {
public:
    enum class Status : uint32_t { Stopped, Starting, Missing, Preparing, Ready,
                                   Rejected, Faulted };
    struct VerifiedIdentitySnapshot {
        std::vector<uint8_t> package;
        std::array<uint8_t,32> packageSha256{};
        std::string engineId;
        uint64_t acceptedGeneration=0;
        // Active only if the worker reports Ready. A retained verified image
        // on stop/fault is not proof of currently running DSP.
        bool active=false;
    };
    struct PreparedNewLedger {
        std::uint64_t requestId=0;
        std::uint64_t acceptedGeneration=0;
        std::array<std::uint8_t,32> packageSha256{};
        std::vector<std::uint8_t> encodedLedger{};
        // D7A: worker-attested but NOT yet published to RT. The ticket must
        // remain zero until D7B's fenced explicit persistence transaction.
        GenericAuthorizationSnapshot stagedAuthorization{};
    };
    // Non-RT read only: copy a prepared candidate only if it still belongs
    // to the active worker generation. This is NEVER a persisted binding or
    // permission to emit DAW edits; D7 must explicitly commit and authorize.
    bool readPreparedNewLedger(std::uint64_t requestId,
                               PreparedNewLedger& out) {
        std::lock_guard<std::mutex> guard(commandMutex_);
        if(requestId==0||commandPending_||
           stopping_.load(std::memory_order_acquire) ||
           status_.load(std::memory_order_acquire)!=Status::Ready ||
           prepared_.requestId!=requestId||
           prepared_.encodedLedger.empty()||
           prepared_.stagedAuthorization.ticket!=0||
           prepared_.stagedAuthorization.acceptedGeneration!=
               prepared_.acceptedGeneration||
           prepared_.stagedAuthorization.verifiedPackageSha256!=
               prepared_.packageSha256||
           prepared_.stagedAuthorization.allowedMask==0||
           prepared_.acceptedGeneration!=
               accepted_.load(std::memory_order_acquire))return false;
        out=prepared_;
        return true;
    }
    std::uint64_t lastPreparedLedgerWord() const noexcept {
        return lastPreparedLedger_.load(std::memory_order_acquire);
    }
    // D7B: observed only on the non-RT host. The worker commits the
    // attested FWS3 bytes BEFORE publishing its RT ticket in one mutex fence.
    // This result is the logical project-state source for Processor getState.
    std::uint64_t lastCommittedLedgerWord() const noexcept {
        return lastCommittedLedger_.load(std::memory_order_acquire);
    }
    bool readCommittedNewLedger(PreparedNewLedger& out) {
        std::lock_guard<std::mutex> guard(commandMutex_);
        if(commandPending_ || stopping_.load(std::memory_order_acquire) ||
           status_.load(std::memory_order_acquire)!=Status::Ready ||
           committed_.encodedLedger.empty()||!committedTicket_ ||
           committed_.acceptedGeneration!=
               accepted_.load(std::memory_order_acquire)||
           genericAuthorization_.workerCurrentTicket()!=committedTicket_)
            return false;
        out=committed_;
        return true;
    }
    NativeWorkerService() {
        // Same stable object lifetime as the worker, never configured by RT.
        mailbox_.workerSetTaggedValidator(&NativeWorkerService::validateTagged,this);
    }
    NativeWorkerService(const NativeWorkerService&)=delete;
    NativeWorkerService& operator=(const NativeWorkerService&)=delete;
    ~NativeWorkerService(){stop();}
    // RT owns solely rtSubmit/rtReadWet; caller MUST stop DAW callback before
    // calling stop or destroying this object. Non-RT methods may allocate.
    AsyncPcmMailbox& mailbox() noexcept {return mailbox_;}
    GenericAuthorizationMailbox& genericAuthorization() noexcept {
        return genericAuthorization_;
    }
    std::uint64_t lastAuthorizationWord() const noexcept {
        return lastAuthorization_.load(std::memory_order_acquire);
    }
    Status status() const noexcept {return status_.load(std::memory_order_acquire);}
    uint64_t acceptedVersion() const noexcept {
        return accepted_.load(std::memory_order_acquire);
    }
    uint64_t handledRequests() const noexcept {
        return handled_.load(std::memory_order_acquire);
    }
    // Request correlation is a single atomic record, so id+outcome cannot
    // be mismatched during concurrent UI polls. Controller serializes loads.
    uint64_t lastCompletedWord() const noexcept {
        return lastCompleted_.load(std::memory_order_acquire);
    }
    uint64_t lastCompletedId() const noexcept {
        return lastCompleted_.load(std::memory_order_acquire)>>1;
    }
    bool lastCompletedSucceeded() const noexcept {
        return (lastCompleted_.load(std::memory_order_acquire)&1u)!=0;
    }
    // Called only on non-audio host lifecycle/getState threads. A load
    // request is NOT committed here: only a successful worker prepare may
    // replace these exact self-contained engine archive bytes.
    std::vector<uint8_t> verifiedPackageSnapshot() const {
        std::lock_guard<std::mutex> guard(verifiedMutex_);
        return verified_.package;
    }
    // Non-RT coherent copy of last successfully ACTIVATED package metadata.
    // Status is read under the same identity mutex, but the caller must
    // verify generation again when committing a later project save.
    VerifiedIdentitySnapshot verifiedIdentitySnapshot() const {
        std::lock_guard<std::mutex> guard(verifiedMutex_);
        auto snapshot=verified_;
        snapshot.active=!snapshot.package.empty() &&
            !snapshot.engineId.empty() && snapshot.acceptedGeneration>0 &&
            status_.load(std::memory_order_acquire)==Status::Ready;
        return snapshot;
    }
    bool clearVerifiedWhenStopped() {
        if(thread_.joinable())return false;
        std::lock_guard<std::mutex> guard(verifiedMutex_);
        verified_=VerifiedIdentitySnapshot{};
        genericAuthorization_.workerRevoke();
        return true;
    }
    bool start() noexcept {
        if(thread_.joinable())return false;
        genericAuthorization_.workerRevoke();
        stopping_.store(false,std::memory_order_release);
        status_.store(Status::Starting,std::memory_order_release);
        try {
            thread_=std::thread([this]{run();});
        }catch(...) {
            status_.store(Status::Stopped,std::memory_order_release);
            return false;
        }
        return true;
    }
    // NonRT GUI/controller producer. It does not open arbitrary filesystem
    // paths; a bounded complete .fwengine package is the only input.
    bool postPackage(std::vector<uint8_t> bytes,double sampleRate,
                     uint32_t channels,uint32_t maxFrames=128,
                     uint64_t requestId=0) {
        if(!thread_.joinable()||bytes.empty()||bytes.size()>8*1024*1024||
           requestId>(UINT64_MAX>>1)||
           !(sampleRate>0.)||!(channels==1||channels==2)||
           maxFrames==0||maxFrames>128)return false;
        std::lock_guard<std::mutex> lock(commandMutex_);
        if(commandPending_||stopping_.load(std::memory_order_acquire))
            return false;
        pending_.bytes=std::move(bytes);
        pending_.rate=sampleRate;
        pending_.channels=channels;
        pending_.frames=maxFrames;
        pending_.requestId=requestId;
        commandPending_=true;
        prepared_=PreparedNewLedger{};
        committed_=PreparedNewLedger{};committedTicket_=0;
        genericAuthorization_.workerRevoke(); // pending replacement is inert
        return true;
    }
    // A project with no module must return to delayed Dry, not keep
    // another project's last active engine. This command executes on the
    // worker; no native handle is freed in the RT callback.
    bool postClear(uint64_t requestId=0) {
        if(!thread_.joinable()||requestId>(UINT64_MAX>>1))return false;
        std::lock_guard<std::mutex> guard(commandMutex_);
        if(commandPending_||stopping_.load(std::memory_order_acquire))
            return false;
        pending_=Request{};
        pending_.unload=true;
        pending_.requestId=requestId;
        commandPending_=true;
        prepared_=PreparedNewLedger{};
        committed_=PreparedNewLedger{};committedTicket_=0;
        genericAuthorization_.workerRevoke();
        return true;
    }
    // Non-RT request only; currently no host/UI command invokes this.
    // Project must be exact FWS3 bytes/ledger. Runtime re-verifies descriptor
    // against the worker-owned LIVE Wasmi handle, never the UI's claim.
    bool postAuthorization(EngineProjectState project,
                           std::vector<std::uint8_t> descriptor,
                           std::uint64_t requestId=0) {
        if(!thread_.joinable() || requestId>(UINT64_MAX>>1) ||
           project.package.empty() || project.package.size()>8*1024*1024 ||
           project.bindingLedger.empty() || descriptor.empty() ||
           descriptor.size()>65536)return false;
        std::lock_guard<std::mutex> lock(commandMutex_);
        if(commandPending_||stopping_.load(std::memory_order_acquire))
            return false;
        pending_=Request{};
        pending_.project=std::move(project);
        pending_.descriptor=std::move(descriptor);
        pending_.authorize=true;
        pending_.requestId=requestId;
        commandPending_=true;
        prepared_=PreparedNewLedger{};
        committed_=PreparedNewLedger{};committedTicket_=0;
        genericAuthorization_.workerRevoke();
        return true;
    }
    // Request fresh-FWS3 identity evidence from the currently LIVE Wasmi
    // worker. Intentionally does NOT publish a ticket, update saved state,
    // or revoke unrelated existing permission: this is read-only preparation.
    bool postPrepareNewLedger(std::vector<std::uint8_t> descriptor,
                              std::uint64_t requestId) {
        if(!thread_.joinable()||requestId==0||
           requestId>static_cast<std::uint64_t>(INT64_MAX)||
           descriptor.empty()||descriptor.size()>65536)return false;
        std::lock_guard<std::mutex> guard(commandMutex_);
        if(commandPending_||stopping_.load(std::memory_order_acquire)||
           status_.load(std::memory_order_acquire)!=Status::Ready)return false;
        pending_=Request{};
        pending_.descriptor=std::move(descriptor);
        pending_.requestId=requestId;
        pending_.prepareLedger=true;
        commandPending_=true;
        prepared_=PreparedNewLedger{};
        // Never replace an already-committed FWS3 binding through candidate
        // preparation. Previous live authorizations stay as-is.
        return true;
    }
    // The Processor MUST check its saved ledger is empty while holding
    // projectStateMutex_ before posting. A later explicit new binding
    // operation cannot silently migrate any prior project mapping.
    bool postCommitPreparedNewLedger(std::uint64_t requestId,
                                     bool explicitUserIntent) {
        if(!explicitUserIntent||!thread_.joinable()||requestId==0||
           requestId>static_cast<std::uint64_t>(INT64_MAX))return false;
        std::lock_guard<std::mutex> guard(commandMutex_);
        if(commandPending_||stopping_.load(std::memory_order_acquire)||
           status_.load(std::memory_order_acquire)!=Status::Ready ||
           prepared_.requestId!=requestId||
           prepared_.encodedLedger.empty()||!committed_.encodedLedger.empty()||
           prepared_.stagedAuthorization.allowedMask==0 ||
           prepared_.stagedAuthorization.ticket!=0 ||
           prepared_.acceptedGeneration!=
               accepted_.load(std::memory_order_acquire))
            return false;
        pending_=Request{};
        pending_.commitLedger=true;
        pending_.requestId=requestId;
        commandPending_=true;
        return true;
    }
    // NonRT only. Host must quiesce audio process first.
    void stop() noexcept {
        // Flip the worker stop gate before revocation; a pending worker
        // completion may never publish a permission after this boundary.
        stopping_.store(true,std::memory_order_release);
        genericAuthorization_.workerRevoke();
        if(thread_.joinable())thread_.join();
        {
            std::lock_guard<std::mutex> lock(commandMutex_);
            pending_=Request{};commandPending_=false;
            prepared_=PreparedNewLedger{};
            committed_=PreparedNewLedger{};
            committedTicket_=0;
        }
        // No worker or audio callback remains; all pending PCM is discarded.
        mailbox_.detachWorkerWhenStopped();
        genericAuthorization_.resetStopped();
        status_.store(Status::Stopped,std::memory_order_release);
    }
private:
    struct Request {
        std::vector<uint8_t> bytes;
        double rate=48000.;
        uint32_t channels=2,frames=128;
        uint64_t requestId=0;
        bool unload=false;
        bool authorize=false;
        bool prepareLedger=false;
        bool commitLedger=false;
        EngineProjectState project{};
        std::vector<std::uint8_t> descriptor{};
    };
    // Checked exclusively on the non-RT worker before AND after Wasmi.
    // The FWS3 descriptor/codec was published on this same live handle.
    static bool validateTagged(void* context,
                               const AsyncPcmMailbox::Input& job) noexcept {
        auto* self=static_cast<NativeWorkerService*>(context);
        if(!self || !job.authorization.ticket || !self->workerNativeActive_ ||
           self->status_.load(std::memory_order_acquire)!=Status::Ready ||
           self->genericAuthorization_.workerCurrentTicket()!=
               job.authorization.ticket ||
           self->workerAuthorized_.ticket!=job.authorization.ticket ||
           self->workerAuthorized_.acceptedGeneration!=
               job.authorization.acceptedGeneration ||
           self->workerAuthorized_.verifiedPackageSha256!=
               job.authorization.packageSha256 ||
           self->accepted_.load(std::memory_order_acquire)!=
               job.authorization.acceptedGeneration)return false;
        for(std::uint32_t i=0;i<job.eventCount;i++) {
            const auto& event=job.events[i];
            if(event.id<64)continue; // old physical semantics unaffected
            if(event.id>127 ||
               !(self->workerAuthorized_.allowedMask&
                   (std::uint64_t{1}<<(event.id-64))) ||
               !fw_native_generic_value_in_contract(
                   self->workerNativeActive_,event.id,event.value))
                return false;
        }
        return true;
    }
    static int32_t processNative(void* context,const float* input,float* output,
                                 uint32_t frames,const FWNativeEvent* events,
                                 uint32_t count) noexcept {
        if(!context)return -1;
        auto* native=static_cast<FWNativeOpaque*>(context);
        // Explicit semantic guard: generic Identity/Gain module has slot64
        // only, so never forward unrelated spectral host parameter events.
        const bool spectral=fw_native_supports_stream_controls(native);
        const uint64_t mask=spectral?fw_native_stream_control_mask(native):0;
        const uint64_t genericMask=fw_native_generic_slot_mask(native);
        // Keep BOTH contracts valid: verified Stream IDs and demo Gain ID64.
        // Filtering is on this off-RT thread; no heap allocations or host
        // parameter semantic aliasing are introduced.
        if(count>AsyncPcmMailbox::kMaxEvents||(count>0&&!events))return -1;
        std::array<FWNativeEvent,AsyncPcmMailbox::kMaxEvents> filtered{};
        uint32_t used=0;
        for(uint32_t i=0;i<count;i++) {
            const bool physical=spectral && events[i].id<64 &&
                StreamHostEvents::bound(events[i].id) &&
                ((mask>>events[i].id)&1ull)!=0;
            // WASM owns the capability; tagged packets additionally pass
            // the FWS3 ticket+semantic+numeric contract in validateTagged.
            const bool generic=events[i].id>=64 && events[i].id<=127 &&
                (genericMask&(std::uint64_t{1}<<(events[i].id-64)))!=0;
            const bool bound=physical||generic;
            if(bound)filtered[used++]=events[i];
        }
        return fw_native_process(native,input,output,frames,
                                 used?filtered.data():nullptr,used);
    }
    void run() noexcept {
        FWNativeOpaque* active=nullptr;
        status_.store(Status::Missing,std::memory_order_release);
        while(!stopping_.load(std::memory_order_acquire)) {
            Request req{};
            bool haveCommand=false;
            {
                // Locking is only on WORKER, never in RT mailbox API.
                std::lock_guard<std::mutex> lock(commandMutex_);
                if(commandPending_) {
                    req=std::move(pending_);
                    pending_=Request{};
                    commandPending_=false;
                    haveCommand=true;
                }
            }
            if(haveCommand && req.unload) {
                genericAuthorization_.workerRevoke();
                workerAuthorized_=GenericAuthorizationSnapshot{};
                workerNativeActive_=nullptr;
                mailbox_.workerConfigure(nullptr,nullptr,0);
                if(active)fw_native_destroy(std::exchange(active,nullptr));
                {
                    std::lock_guard<std::mutex> guard(verifiedMutex_);
                    verified_=VerifiedIdentitySnapshot{};
                }
                status_.store(Status::Missing,std::memory_order_release);
                lastCompleted_.store((req.requestId<<1)|1ull,std::memory_order_release);
                handled_.fetch_add(1,std::memory_order_release);
            } else if(haveCommand && req.authorize) {
                // Every authority check below is worker-owned and non-RT.
                bool approved=false;
                // A malformed external descriptor or allocation failure may
                // deny authorization, but must never terminate the worker.
                try {
                if(active && status_.load(std::memory_order_acquire)==Status::Ready) {
                    const auto current=verifiedIdentitySnapshot();
                    VerifiedProjectEngine verified{};
                    verified.package=current.package;
                    verified.engineId=current.engineId;
                    verified.sha256=current.packageSha256;
                    verified.acceptedGeneration=current.acceptedGeneration;
                    verified.active=current.active;
                    const auto plan=buildGenericAuthorizationPlan(
                        req.project,verified,fw_native_generic_slot_mask(active),
                        req.descriptor,
                        [active](const SlotBindingIdentity& binding,
                                 const std::vector<std::uint8_t>& json){
                            return fw_native_preflight_generic_descriptor(
                                active,json.data(),json.size(),binding.hostSlot,
                                reinterpret_cast<const std::uint8_t*>(
                                    binding.semanticId.data()),
                                binding.semanticId.size(),binding.codecRevision);
                        });
                    GenericAuthorizationSnapshot snapshot{};
                    if(buildGenericAuthorizationSnapshot(
                           plan,[active](std::uint32_t slot,FWNativeGenericCodec& codec){
                               return fw_native_copy_generic_codec(active,slot,&codec);
                           },snapshot) &&
                       status_.load(std::memory_order_acquire)==Status::Ready &&
                       accepted_.load(std::memory_order_acquire)==
                           snapshot.acceptedGeneration) {
                        // The GUI producers postPackage/postClear/postAuthorization
                        // revoke under this SAME mutex. Do not let a worker
                        // finish old proof and then publish AFTER their revoke.
                        // This is non-RT: processTyped never takes this lock.
                        std::lock_guard<std::mutex> commitGuard(commandMutex_);
                        if(!commandPending_ &&
                           !stopping_.load(std::memory_order_acquire)) {
                            approved=genericAuthorization_.workerPublish(
                                snapshot,current.acceptedGeneration,
                                current.packageSha256);
                            if(approved) {
                                snapshot.ticket=genericAuthorization_.workerCurrentTicket();
                                workerAuthorized_=snapshot;
                                workerNativeActive_=active;
                            }
                        }
                    }
                }
                }catch(...) {approved=false;}
                if(!approved) {
                    genericAuthorization_.workerRevoke();
                    workerAuthorized_=GenericAuthorizationSnapshot{};
                }
                lastAuthorization_.store((req.requestId<<1)|(approved?1ull:0ull),
                                         std::memory_order_release);
            } else if(haveCommand && req.commitLedger) {
                bool committed=false;
                // This single worker-side fence owns both the logical FWS3
                // commit and permission publication. No GUI thread calls
                // workerPublish (SPSC producer remains the Worker).
                {
                    std::lock_guard<std::mutex> guard(commandMutex_);
                    if(!commandPending_ &&
                       !stopping_.load(std::memory_order_acquire) &&
                       status_.load(std::memory_order_acquire)==Status::Ready &&
                       committed_.encodedLedger.empty() &&
                       prepared_.requestId==req.requestId &&
                       !prepared_.encodedLedger.empty() &&
                       prepared_.acceptedGeneration!=0 &&
                       prepared_.acceptedGeneration==
                           accepted_.load(std::memory_order_acquire) &&
                       prepared_.stagedAuthorization.ticket==0 &&
                       prepared_.stagedAuthorization.allowedMask!=0 &&
                       prepared_.stagedAuthorization.acceptedGeneration==
                           prepared_.acceptedGeneration &&
                       prepared_.stagedAuthorization.verifiedPackageSha256==
                           prepared_.packageSha256) {
                        committed_=std::move(prepared_);
                        // Ledger state becomes committed BEFORE any RT ticket
                        // becomes visible. Failed publication rolls back.
                        committed=genericAuthorization_.workerPublish(
                            committed_.stagedAuthorization,
                            committed_.acceptedGeneration,
                            committed_.packageSha256);
                        if(committed) {
                            committedTicket_=
                                genericAuthorization_.workerCurrentTicket();
                            workerAuthorized_=committed_.stagedAuthorization;
                            workerAuthorized_.ticket=committedTicket_;
                            workerNativeActive_=active;
                        } else {
                            committed_=PreparedNewLedger{};
                            committedTicket_=0;
                            workerAuthorized_=GenericAuthorizationSnapshot{};
                        }
                    }
                    lastCommittedLedger_.store(
                        (req.requestId<<1)|(committed?1ull:0ull),
                        std::memory_order_release);
                }
            } else if(haveCommand && req.prepareLedger) {
                PreparedNewLedger pending{};
                bool prepared=false;
                try {
                    if(active && status_.load(std::memory_order_acquire)==Status::Ready) {
                        const auto current=verifiedIdentitySnapshot();
                        VerifiedProjectEngine verified{};
                        verified.package=current.package;
                        verified.engineId=current.engineId;
                        verified.sha256=current.packageSha256;
                        verified.acceptedGeneration=current.acceptedGeneration;
                        verified.active=current.active;
                        SlotBindingLedger candidate{};
                        if(buildLiveWasmGenericLedgerCandidate(
                               active,verified,req.descriptor.data(),
                               req.descriptor.size(),candidate)) {
                            pending.requestId=req.requestId;
                            pending.acceptedGeneration=current.acceptedGeneration;
                            pending.packageSha256=current.packageSha256;
                            pending.encodedLedger=encodeBindingLedger(candidate);
                            EngineProjectState image{};
                            image.package=current.package;
                            image.bindingLedger=pending.encodedLedger;
                            const auto plan=buildGenericAuthorizationPlan(
                                image,verified,fw_native_generic_slot_mask(active),
                                req.descriptor,
                                [active](const SlotBindingIdentity& binding,
                                         const std::vector<std::uint8_t>& json) {
                                    return fw_native_preflight_generic_descriptor(
                                        active,json.data(),json.size(),binding.hostSlot,
                                        reinterpret_cast<const std::uint8_t*>(
                                            binding.semanticId.data()),
                                        binding.semanticId.size(),binding.codecRevision);
                                });
                            // Numeric codec must be read from this SAME live
                            // Wasmi engine, not from untrusted UI descriptor.
                            prepared=!pending.encodedLedger.empty() &&
                                buildGenericAuthorizationSnapshot(
                                    plan,[active](std::uint32_t slot,
                                                  FWNativeGenericCodec& codec) {
                                        return fw_native_copy_generic_codec(
                                            active,slot,&codec);
                                    },pending.stagedAuthorization) &&
                                pending.stagedAuthorization.ticket==0;
                            // This branch never publishes a permission ticket.
                            // A later explicit D7B commit must reacquire the
                            // current worker+project identity and revalidate.

                        }
                    }
                }catch(...) {prepared=false;}
                // Serialize final publication with GUI load/clear requests.
                // An in-flight new command invalidates the stale candidate.
                {
                    std::lock_guard<std::mutex> guard(commandMutex_);
                    if(prepared && !commandPending_ &&
                       !stopping_.load(std::memory_order_acquire) &&
                       status_.load(std::memory_order_acquire)==Status::Ready &&
                       accepted_.load(std::memory_order_acquire)==
                           pending.acceptedGeneration)
                        prepared_=std::move(pending);
                    else {prepared_=PreparedNewLedger{};prepared=false;}
                    lastPreparedLedger_.store(
                        (req.requestId<<1)|(prepared?1ull:0ull),
                        std::memory_order_release);
                }
            } else if(haveCommand) {
                genericAuthorization_.workerRevoke();
                workerAuthorized_=GenericAuthorizationSnapshot{};
                bool activated=false;
                status_.store(Status::Preparing,std::memory_order_release);
                FWNativeOpaque* candidate=fw_native_prepare(
                    req.bytes.data(),req.bytes.size(),req.rate,
                    req.channels,req.frames);
                const auto latency=candidate?fw_native_latency(candidate):UINT32_MAX;
                std::array<uint8_t,32> hash{};
                std::array<uint8_t,129> name{};
                std::string engineId;
                bool identityOk=false;
                if(candidate) {
                    const uint32_t nameLength=fw_native_copy_verified_identity(
                        candidate,hash.data(),hash.size(),name.data(),name.size());
                    if(nameLength>0&&nameLength<=128&&
                       name[nameLength]==0) {
                        try {
                            engineId.assign(reinterpret_cast<const char*>(name.data()),
                                            nameLength);
                            identityOk=!engineId.empty();
                        }catch(...) {identityOk=false;}
                    }
                }
                if(candidate&&identityOk&&latency<=AsyncPcmMailbox::kHostPdc&&
                    mailbox_.workerConfigure(processNative,candidate,latency)) {
                    auto* retired=std::exchange(active,candidate);
                    workerNativeActive_=active;
                    // Same worker thread cannot be inside workerStep and
                    // load/destroy at once; RT only holds copied PCM packets.
                    if(retired)fw_native_destroy(retired);
                    {
                        std::lock_guard<std::mutex> guard(verifiedMutex_);
                        verified_.package=std::move(req.bytes);
                        verified_.engineId=std::move(engineId);
                        verified_.packageSha256=hash;
                        verified_.acceptedGeneration=
                            accepted_.load(std::memory_order_relaxed)+1u;
                    }
                    accepted_.fetch_add(1,std::memory_order_release);
                    activated=true;
                    status_.store(Status::Ready,std::memory_order_release);
                }else{
                    if(candidate)fw_native_destroy(candidate);
                    // Known-good active module remains configured if load fails.
                    status_.store(active?Status::Ready:Status::Rejected,
                                  std::memory_order_release);
                }
                lastCompleted_.store((req.requestId<<1)|(activated?1ull:0ull),
                                     std::memory_order_release);
                handled_.fetch_add(1,std::memory_order_release);
            }
            bool work=false;
            // A fixed upper bound prevents endless worker-side drain loops
            // from starving later module selection or plugin teardown.
            for(unsigned i=0;i<8;i++) {
                if(!mailbox_.workerStep())break;
                work=true;
            }
            if(active&&fw_native_faulted(active)) {
                genericAuthorization_.workerRevoke();
                workerAuthorized_=GenericAuthorizationSnapshot{};
                workerNativeActive_=nullptr;
                {
                    std::lock_guard<std::mutex> guard(commandMutex_);
                    prepared_=PreparedNewLedger{};
                    committed_=PreparedNewLedger{};
                    committedTicket_=0;
                }
                mailbox_.workerConfigure(nullptr,nullptr,0);
                fw_native_destroy(std::exchange(active,nullptr));
                status_.store(Status::Faulted,std::memory_order_release);
            }
            if(!work&&!haveCommand)
                std::this_thread::sleep_for(std::chrono::milliseconds(1));
        }
        // Worker quiescent: no C ABI call can overlap this destruction.
        genericAuthorization_.workerRevoke();
        workerAuthorized_=GenericAuthorizationSnapshot{};
        workerNativeActive_=nullptr;
        mailbox_.workerConfigure(nullptr,nullptr,0);
        if(active)fw_native_destroy(active);
    }
    AsyncPcmMailbox mailbox_{};
    GenericAuthorizationMailbox genericAuthorization_{};
    // Only ever written/read by worker thread, never by audio callback.
    GenericAuthorizationSnapshot workerAuthorized_{};
    FWNativeOpaque* workerNativeActive_=nullptr;
    std::thread thread_{};
    std::mutex commandMutex_{};
    Request pending_{};
    PreparedNewLedger prepared_{}; // commandMutex_ protected, never RT-owned
    PreparedNewLedger committed_{}; // commandMutex_ protected; saved state evidence
    std::uint64_t committedTicket_=0;
    bool commandPending_=false;
    std::atomic<bool> stopping_{true};
    std::atomic<Status> status_{Status::Stopped};
    std::atomic<uint64_t> accepted_{0};
    std::atomic<uint64_t> handled_{0};
    std::atomic<uint64_t> lastCompleted_{0};
    std::atomic<uint64_t> lastAuthorization_{0};
    std::atomic<uint64_t> lastPreparedLedger_{0};
    std::atomic<uint64_t> lastCommittedLedger_{0};
    mutable std::mutex verifiedMutex_{};
    VerifiedIdentitySnapshot verified_{}; // success-confirmed only

};
} // namespace fw
