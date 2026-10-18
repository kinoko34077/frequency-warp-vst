// S3b4 Stage A: fixed VST3 host with bounded asynchronous wet/Dry fallback.
// Native Wasmi is NEVER called from the audio thread. Actual package loading is S3b4-B.
#include "delay.h"
#include "async_pcm_mailbox.h"
#include "native_engine_abi.h"
#include "native_worker_service.h"
#include "stream_host_events.h"
#include "generic_host_packet.h"
#include "engine_project_state.h"
#include "project_state_stream_reader.h"
#include "project_binding_association.h"
#include "generic_ui_authorization.h"
#include "explicit_generic_ledger_commit_gate.h"
#include "generic_ui_authority_gate.h"
#include "parameter_state_mailbox.h"
#include <climits>
#include <chrono>
#include <cstdlib>
#include "win32_engine_editor.h"
#if defined(_WIN32) && defined(FW_ENABLE_WEBVIEW2)
#include "win32_webview2_editor.h"
#endif
#include "pluginterfaces/base/ibstream.h"
#include "pluginterfaces/vst/ivstmessage.h"
#include <cstring>
#include <atomic>
#include <mutex>
#include <vector>
#include "parameter_registry.h"
#include "base/source/fstring.h"
#include "public.sdk/source/vst/vstaudioeffect.h"
#include "public.sdk/source/vst/vsteditcontroller.h"
#include "public.sdk/source/main/pluginfactory.h"
#include "base/source/fstreamer.h"
#include "pluginterfaces/base/ustring.h"
#include "pluginterfaces/vst/ivstparameterchanges.h"
#include "pluginterfaces/vst/vstspeaker.h"
#include <algorithm>
#include <array>
#include <cmath>
#include <cstdio>
#include <type_traits>

namespace fw {
using namespace Steinberg;
using namespace Steinberg::Vst;
// These two class IDs are fixed at first native creation. Never generate at runtime.
static const FUID kProcessorCID(0xD51B3C20,0x5C574E31,0xB40D7B64,0xA2E8F719);
static const FUID kControllerCID(0xF8C2D41E,0x84B9475B,0xB5DC4E2F,0xB948A0D3);
using Values=std::array<double,kParamCount>;
static Values defaults() {return defaultHostValues();}
// These host IBStream operations run on non-audio lifecycle/getState threads.
// Streams may return partial read/write counts; no seek or filesystem needed.
// Reject an unbounded claimed archive before allocating anything beyond 1KiB.
static bool readExact(IBStream* stream,void* dest,size_t count) {
    auto* ptr=static_cast<uint8_t*>(dest);
    while(count){
        const auto chunk=static_cast<int32>(std::min<size_t>(count,65536));
        int32 received=0;
        if(stream->read(ptr,chunk,&received)!=kResultOk||
           received<=0||received>chunk)return false;
        ptr+=received;count-=static_cast<size_t>(received);
    }
    return true;
}
static bool writeExact(IBStream* stream,const void* data,size_t count) {
    const auto* ptr=static_cast<const uint8_t*>(data);
    while(count) {
        const auto chunk=static_cast<int32>(std::min<size_t>(count,65536));
        int32 written=0;
        if(stream->write(const_cast<uint8_t*>(ptr),chunk,&written)!=kResultOk||
           written<=0||written>chunk)return false;
        ptr+=written;count-=static_cast<size_t>(written);
    }
    return true;
}
static bool readStateImage(IBStream* stream,EngineProjectState& result) {
    if(!stream)return false;
    return readProjectStateStream([stream](void* dest,std::size_t bytes){
        return readExact(stream,dest,bytes);
    },result);
}
static bool readState(IBStream* stream,Values& values){
    EngineProjectState decoded{};
    if(!readStateImage(stream,decoded))return false;
    values=decoded.values;
    return true;
}
static bool writeStateImage(IBStream* stream,const EngineProjectState& image){
    if(!stream)return false;
    try {
        const auto encoded=encodeEngineProjectState(image);
        return writeExact(stream,encoded.data(),encoded.size());
    }catch(...){return false;}
}
class Processor final:public AudioEffect {
public:
    Processor(){setControllerClass(kControllerCID);}
    static FUnknown* createInstance(void*) {
        return static_cast<IAudioProcessor*>(new Processor);
    }
    tresult PLUGIN_API initialize(FUnknown* context) override {
        auto r=AudioEffect::initialize(context);
        if(r!=kResultOk)return r;
        // Static Rust interpreter ABI handshake on host lifecycle, NEVER RT.
        if(fw_native_abi_major()!=1u)return kResultFalse;
        addAudioInput(STR16("Audio In"),SpeakerArr::kStereo);
        addAudioOutput(STR16("Audio Out"),SpeakerArr::kStereo);
        return kResultOk;
    }
    tresult PLUGIN_API setBusArrangements(SpeakerArrangement* in,int32 ni,
        SpeakerArrangement* out,int32 no) override {
        if(ni!=1||no!=1||!in||!out||in[0]!=out[0]||
            (in[0]!=SpeakerArr::kStereo&&in[0]!=SpeakerArr::kMono))return kResultFalse;
        getAudioInput(0)->setArrangement(in[0]);
        getAudioOutput(0)->setArrangement(out[0]);
        hostChannels_ = in[0]==SpeakerArr::kMono ? 1u : 2u;
        return kResultOk;
    }
    tresult PLUGIN_API setupProcessing(ProcessSetup& setup) override {
        if(!std::isfinite(setup.sampleRate)||setup.sampleRate<=0.0||
            setup.maxSamplesPerBlock<1)return kResultFalse;
        const auto result=AudioEffect::setupProcessing(setup);
        if(result==kResultOk) hostSampleRate_=setup.sampleRate;
        return result;
    }
    tresult PLUGIN_API setActive(TBool active) override {
        // Non-RT lifecycle is serialized with project restore/snapshot.
        // Never take this mutex from the audio callback.
        std::lock_guard<std::mutex> projectGuard(projectStateMutex_);
        // Lifecycle is non-RT. Keep the last worker-verified exact archive
        // across host suspend/reactivation; pending project restore overrides it.
        if(!active) {
            // Capture any already fully worker-committed new FWS3 before
            // quiescent teardown. A pending proof without a ticket is inert.
            try { if(savedBindingLedger_.empty())absorbCommittedNewLedger(); }
            catch(...) { /* remain fail-closed, never invent bindings */ }
            workerActive_=false;
            worker_.stop();
            delay_.reset();
            return AudioEffect::setActive(active);
        }
        delay_.reset();
        const auto result=AudioEffect::setActive(active);
        if(result!=kResultOk)return result;
        if(!worker_.start()) {
            AudioEffect::setActive(false);
            return kResultFalse;
        }
        try {
            auto package=deferredRestorePending_
                ? deferredRestorePackage_ : worker_.verifiedPackageSnapshot();
            if(!package.empty() &&
               !worker_.postPackage(std::move(package),hostSampleRate_,
                      hostChannels_,AsyncPcmMailbox::kMaxFrames,0)) {
                worker_.stop();
                AudioEffect::setActive(false);
                return kResultFalse;
            }
        }catch(...) {
            worker_.stop();
            AudioEffect::setActive(false);
            return kResultFalse;
        }
        deferredRestorePackage_.clear();
        deferredRestorePending_=false;
        workerActive_=true;
        return kResultOk;
    }
    // Controller-to-Processor single-file package transport. The actual
    // file chooser and drag/drop UI are S3c. Host-mediated notify is NOT
    // invoked from the audio callback; it only queues bytes for the worker.
    tresult PLUGIN_API notify(IMessage* message) override {
        if(!message||!message->getMessageID())return kInvalidArgument;
        if(std::strcmp(message->getMessageID(),"FrequencyWarp.QueryEngineV1")==0) {
            // Request and response remain on the host's non-audio message path.
            // Worker status is atomic; never send host messages from process().
            IMessage* reply=allocateMessage();
            if(!reply)return kResultFalse;
            reply->setMessageID("FrequencyWarp.EngineStatusV1");
            auto* result=reply->getAttributes();
            const uint64_t done=worker_.lastCompletedWord();
            const bool ok=result &&
                result->setInt("request",static_cast<int64>(done>>1))==kResultTrue &&
                result->setInt("succeeded",static_cast<int64>(done&1u))==kResultTrue &&
                result->setInt("accepted",static_cast<int64>(worker_.acceptedVersion()))==kResultTrue &&
                result->setInt("handled",static_cast<int64>(worker_.handledRequests()))==kResultTrue &&
                result->setInt("status",static_cast<int64>(worker_.status()))==kResultTrue;
            const auto response=ok?sendMessage(reply):kResultFalse;
            reply->release();
            return response;
        }
        if(std::strcmp(message->getMessageID(),
                       "FrequencyWarp.QuerySavedGenericV1")==0) {
            // Non-audio host query. No GUI claim can create authority.
            auto* reply=allocateMessage();
            if(!reply)return kResultFalse;
            reply->setMessageID("FrequencyWarp.SavedGenericStatusV1");
            auto* result=reply->getAttributes();
            const auto done=worker_.lastAuthorizationWord();
            // Historical success alone is NOT current edit authority.
            // The worker can revoke on unload/swap/fault after this result.
            const bool currentlyActive=(done&1u)!=0 &&
                worker_.status()==NativeWorkerService::Status::Ready &&
                worker_.genericAuthorization().workerCurrentTicket()!=0;
            const bool ok=result &&
                result->setInt("request",static_cast<int64>(done>>1))==kResultTrue &&
                result->setInt("succeeded",static_cast<int64>(done&1u))==kResultTrue &&
                result->setInt("active",static_cast<int64>(currentlyActive))==kResultTrue;
            const auto response=ok?sendMessage(reply):kResultFalse;
            reply->release();
            return response;
        }
        if(std::strcmp(message->getMessageID(),
                       "FrequencyWarp.AuthorizeSavedGenericV1")==0) {
            auto* attrs=message->getAttributes();
            if(!attrs)return kResultFalse;
            const void* data=nullptr;
            uint32 length=0;
            int64 request=0;
            if(attrs->getBinary("descriptor",data,length)!=kResultTrue ||
               attrs->getInt("request",request)!=kResultTrue ||
               request<=0 ||
               !validGenericUiRequest(static_cast<uint64_t>(request),
                      static_cast<const uint8_t*>(data),length))
                return kResultFalse;
            // Worker receives ONLY the current verified engine and the
            // already-saved semantic ledger; never trust UI-supplied package,
            // identity, hash or binding. No silent creation of a new FWS3.
            std::lock_guard<std::mutex> projectGuard(projectStateMutex_);
            if(!workerActive_)return kResultFalse;
            try {
                const auto identity=worker_.verifiedIdentitySnapshot();
                VerifiedProjectEngine verified{};
                verified.package=identity.package;
                verified.engineId=identity.engineId;
                verified.sha256=identity.packageSha256;
                verified.acceptedGeneration=identity.acceptedGeneration;
                verified.active=identity.active;
                EngineProjectState project{};
                if(!prepareSavedGenericUiAuthorization(
                        verified,savedBindingLedger_,
                        static_cast<const uint8_t*>(data),length,
                        static_cast<uint64_t>(request),project))
                    return kResultFalse;
                const auto* first=static_cast<const uint8_t*>(data);
                std::vector<uint8_t> descriptor(first,first+length);
                return worker_.postAuthorization(
                    std::move(project),std::move(descriptor),
                    static_cast<uint64_t>(request)) ? kResultOk:kResultFalse;
            }catch(...) {return kResultFalse;}
        }
        if(std::strcmp(message->getMessageID(),
                       "FrequencyWarp.PrepareNewGenericV1")==0) {
            auto* a=message->getAttributes();
            if(!a)return kResultFalse;
            const void* bytes=nullptr;
            uint32 size=0;
            int64 request=0,explicitIntent=0;
            if(a->getBinary("descriptor",bytes,size)!=kResultTrue ||
               a->getInt("request",request)!=kResultTrue ||
               a->getInt("explicit",explicitIntent)!=kResultTrue ||
               explicitIntent!=1 || request<=0 ||
               !validGenericUiRequest(static_cast<uint64_t>(request),
                                     static_cast<const uint8_t*>(bytes),size))
                return kResultFalse;
            std::lock_guard<std::mutex> projectGuard(projectStateMutex_);
            if(!workerActive_||!savedBindingLedger_.empty())return kResultFalse;
            try {
                const auto* start=static_cast<const uint8_t*>(bytes);
                std::vector<uint8_t> proposal(start,start+size);
                return worker_.postPrepareNewLedger(
                    std::move(proposal),static_cast<uint64_t>(request))
                    ? kResultOk:kResultFalse;
            } catch(...) {return kResultFalse;}
        }
        if(std::strcmp(message->getMessageID(),
                       "FrequencyWarp.CommitNewGenericV1")==0) {
            auto* a=message->getAttributes();
            if(!a)return kResultFalse;
            int64 request=0,explicitIntent=0;
            if(a->getInt("request",request)!=kResultTrue ||
               a->getInt("explicit",explicitIntent)!=kResultTrue ||
               explicitIntent!=1||request<=0)return kResultFalse;
            std::lock_guard<std::mutex> projectGuard(projectStateMutex_);
            if(!workerActive_||!savedBindingLedger_.empty())return kResultFalse;
            return worker_.postCommitPreparedNewLedger(
                static_cast<uint64_t>(request),true)?kResultOk:kResultFalse;
        }
        if(std::strcmp(message->getMessageID(),
                       "FrequencyWarp.QueryNewGenericV1")==0) {
            std::lock_guard<std::mutex> projectGuard(projectStateMutex_);
            const auto prepared=worker_.lastPreparedLedgerWord();
            const auto committed=worker_.lastCommittedLedgerWord();
            bool saved=!savedBindingLedger_.empty();
            if(!saved&&(committed&1u)!=0) {
                try {saved=absorbCommittedNewLedger();}catch(...){saved=false;}
            }
            // GUI permission must be derived from the saved semantic
            // ledger and CURRENT worker ticket. Never use last success word,
            // HTML binding hints or raw WASM capability mask.
            std::uint64_t uiMask=0;
            try {
                const auto ticket=worker_.genericAuthorization().workerCurrentTicket();
                if(saved&&ticket && worker_.status()==NativeWorkerService::Status::Ready) {
                    const auto actual=worker_.verifiedIdentitySnapshot();
                    VerifiedProjectEngine verified{};
                    verified.active=actual.active;
                    verified.acceptedGeneration=actual.acceptedGeneration;
                    verified.package=actual.package;
                    verified.engineId=actual.engineId;
                    verified.sha256=actual.packageSha256;
                    EngineProjectState image{};
                    image.package=actual.package;
                    image.bindingLedger=savedBindingLedger_;
                    uiMask=verifiedGenericUiMask(image,verified,ticket);
                    if(worker_.genericAuthorization().workerCurrentTicket()!=ticket)
                        uiMask=0; // revoke during query
                }
            } catch(...) {uiMask=0;}
            const bool active=uiMask!=0;
            auto* reply=allocateMessage();
            if(!reply)return kResultFalse;
            reply->setMessageID("FrequencyWarp.NewGenericStatusV1");
            auto* a=reply->getAttributes();
            const bool ok=a &&
                a->setInt("preparedRequest",static_cast<int64>(prepared>>1))==kResultTrue &&
                a->setInt("prepared",static_cast<int64>(prepared&1u))==kResultTrue &&
                a->setInt("committedRequest",static_cast<int64>(committed>>1))==kResultTrue &&
                a->setInt("committed",static_cast<int64>(committed&1u))==kResultTrue &&
                a->setInt("saved",static_cast<int64>(saved))==kResultTrue &&
                a->setInt("active",static_cast<int64>(active))==kResultTrue &&
                a->setInt("maskLo",static_cast<int64>(
                    static_cast<std::uint32_t>(uiMask)))==kResultTrue &&
                a->setInt("maskHi",static_cast<int64>(
                    static_cast<std::uint32_t>(uiMask>>32)))==kResultTrue;
            const auto result=ok?sendMessage(reply):kResultFalse;
            reply->release();
            return result;
        }
        if(std::strcmp(message->getMessageID(),"FrequencyWarp.LoadFwengineV1")!=0)
            return AudioEffect::notify(message);
        auto* attrs=message->getAttributes();
        if(!attrs)return kResultFalse;
        const void* bytes=nullptr;
        uint32 size=0;
        if(attrs->getBinary("package",bytes,size)!=kResultTrue ||
           !bytes||size==0||size>8*1024*1024)return kResultFalse;
        int64 requestId=0;
        if(attrs->getInt("request",requestId)!=kResultTrue||requestId<=0)
            return kResultFalse;
        // Rejection never replaces the last valid engine. Unsupported mono/
        // stereo arrangement is refused earlier by setBusArrangements.
        const uint32 channels=hostChannels_;
        std::vector<uint8_t> copy;
        try {
            const auto* first=static_cast<const uint8_t*>(bytes);
            copy.assign(first,first+size);
        }catch(...) { return kResultFalse; }
        return worker_.postPackage(std::move(copy),hostSampleRate_,
                                  channels,AsyncPcmMailbox::kMaxFrames,
                                  static_cast<uint64_t>(requestId))
            ? kResultOk:kResultFalse;
    }
    tresult PLUGIN_API canProcessSampleSize(int32 size) override {
        return (size==kSample32||size==kSample64)?kResultTrue:kResultFalse;
    }
    uint32 PLUGIN_API getLatencySamples() override {return kLatency;}
    tresult PLUGIN_API getState(IBStream* stream) override {
        // Only the exact previously worker-verified archive may carry an
        // FWS3 semantic ledger. Never silently downgrade an unmatched FWS3
        // project to FWS2, even while a new engine is being prepared.
        std::lock_guard<std::mutex> projectGuard(projectStateMutex_);
        EngineProjectState image{};
        if(!parameterMailbox_.uiSnapshot(image.values))return kResultFalse;
        try {
            if(savedBindingLedger_.empty() &&
               (worker_.lastCommittedLedgerWord()&1u)!=0 &&
               worker_.genericAuthorization().workerCurrentTicket()!=0 &&
               !absorbCommittedNewLedger())
                return kResultFalse;
            auto accepted=worker_.verifiedIdentitySnapshot();
            image.package=accepted.package;
            if(!savedBindingLedger_.empty()) {
                image.bindingLedger=savedBindingLedger_;
                VerifiedProjectEngine identity{};
                identity.package=std::move(accepted.package);
                identity.engineId=std::move(accepted.engineId);
                identity.sha256=accepted.packageSha256;
                identity.acceptedGeneration=accepted.acceptedGeneration;
                identity.active=accepted.active;
                if(!matchSavedBindingToVerifiedEngine(image,identity))
                    return kResultFalse; // preserved ledger stays inert, not discarded
            }
        }catch(...) {return kResultFalse;}
        return writeStateImage(stream,image)?kResultOk:kResultFalse;
    }
    tresult PLUGIN_API setState(IBStream* stream) override {
        EngineProjectState image{};
        if(!readStateImage(stream,image))return kResultFalse;
        // Decode is atomic. Do not modify host params if the non-RT worker
        // cannot accept the restore/unload command at this moment.
        std::lock_guard<std::mutex> projectGuard(projectStateMutex_);
        if(workerActive_) {
            const bool queued=image.package.empty()
                ? worker_.postClear(0)
                : worker_.postPackage(std::move(image.package),hostSampleRate_,
                      hostChannels_,AsyncPcmMailbox::kMaxFrames,0);
            if(!queued)return kResultFalse;
        }else{
            // While inactive only stage bytes; the same verification worker
            // will prepare them on activation. Empty image must clear the
            // previous project's already-verified engine.
            if(image.package.empty()&&!worker_.clearVerifiedWhenStopped())
                return kResultFalse;
            deferredRestorePackage_=std::move(image.package);
            deferredRestorePending_=true;
        }
        savedBindingLedger_=std::move(image.bindingLedger);
        parameterMailbox_.uiStage(image.values);
        return kResultOk;
    }
    struct Queue {
        IParamValueQueue* queue=nullptr;
        ParamID id=0;
        int32 count=0,next=0,offset=0;
        ParamValue value=0;
    };
    template<class Sample> tresult processTyped(ProcessData& data) {
        if(data.numSamples<0)return kInvalidArgument;
        // The UI thread may call setState/getState while Processing. The
        // audio callback alone owns values_; a complete pending project is
        // consumed at this callback boundary with a bounded atomic snapshot.
        parameterMailbox_.rtAdopt(values_);
        // R3C2C1 only: adopt verified fixed POD; no generic DAW routing yet.
        worker_.genericAuthorization().rtAdopt();
        std::array<Queue,kParamCount> cursors{};
        int32 used=0;
        if(auto* changes=data.inputParameterChanges) {
            const int32 n=changes->getParameterCount();
            if(n<0||n>static_cast<int32>(kParamCount))return kResultFalse;
            for(int32 i=0;i<n;i++) {
                auto* q=changes->getParameterData(i);
                if(!q)continue;
                const auto id=q->getParameterId();
                if(id>=kParamCount)return kResultFalse;
                Queue& c=cursors[used++];c.queue=q;c.id=id;c.count=q->getPointCount();
                if(c.count<0)return kResultFalse;
                int32 previous=-1;
                for(int32 p=0;p<c.count;p++) {
                    int32 offset=0;ParamValue value=0;
                    if(q->getPoint(p,offset,value)!=kResultTrue||
                        !std::isfinite(value)||value<0.||value>1.||
                        offset<previous||offset<0||
                        (data.numSamples==0 ? offset!=0:offset>=data.numSamples))
                        return kResultFalse;
                    previous=offset;
                }
                if(c.count&&q->getPoint(0,c.offset,c.value)!=kResultTrue)return kResultFalse;
            }
        }
        auto apply=[&](int32 frame) noexcept {
            for(int32 i=0;i<used;i++) {
                Queue& c=cursors[i];
                while(c.next<c.count&&c.offset==frame) {
                    values_[c.id]=c.value;
                    if(++c.next<c.count)c.queue->getPoint(c.next,c.offset,c.value);
                }
            }
        };
        if(data.numSamples==0){
            apply(0);
            parameterMailbox_.rtPublish(values_);
            return kResultOk;
        }
        if(data.numInputs!=1||data.numOutputs!=1||!data.inputs||!data.outputs)
            return kResultFalse;
        const auto& src=data.inputs[0];auto& dst=data.outputs[0];
        if(src.numChannels!=dst.numChannels||
           (src.numChannels!=1&&src.numChannels!=2))return kResultFalse;
        for(int32 ch=0;ch<src.numChannels;ch++) {
            if constexpr(std::is_same_v<Sample,Sample32>) {
                if(!src.channelBuffers32||!dst.channelBuffers32||!dst.channelBuffers32[ch]||
                   (!(src.silenceFlags&(uint64(1)<<ch))&&!src.channelBuffers32[ch]))
                    return kResultFalse;
            } else {
                if(!src.channelBuffers64||!dst.channelBuffers64||!dst.channelBuffers64[ch]||
                   (!(src.silenceFlags&(uint64(1)<<ch))&&!src.channelBuffers64[ch]))
                    return kResultFalse;
            }
        }
        // Chunking is adaptive: each packet begins with eighteen verified physical
        // parameter snapshots (so a newly loaded engine receives host state).
        // Up to 110 more distinct per-sample changes fit the fixed 128-event
        // ABI. If over capacity, split BEFORE consuming any host point.
        // No host automation changes are silently discarded.
        const bool hasWorker=worker_.mailbox().rtHasPreparedWorker();
        std::array<Queue*,StreamHostEvents::kBindingCount> streamQueues{};
        std::array<Queue*,64> genericQueues{};
        for(int32 q=0;q<used;q++){
            const int index=StreamHostEvents::indexOf(cursors[q].id);
            if(index>=0)streamQueues[static_cast<size_t>(index)]=&cursors[q];
            if(cursors[q].id>=64 && cursors[q].id<=127)
                genericQueues[cursors[q].id-64]=&cursors[q];
        }
        for(int32 start=0;start<data.numSamples;) {
            uint32_t frames=0;
            GenericHostPacket controls{};
            // RT audio owns this immutable packet until the next rtAdopt.
            // A worker-side revocation remains observable through the ticket.
            const auto* auth=worker_.genericAuthorization().rtLiveSnapshot();
            AsyncPcmMailbox::AuthorizationTag packetAuth{};
            if(auth) {
                packetAuth.ticket=auth->ticket;
                packetAuth.acceptedGeneration=auth->acceptedGeneration;
                packetAuth.packageSha256=auth->verifiedPackageSha256;
            }
            std::array<std::array<float,AsyncPcmMailbox::kMaxFrames>,2> input{};
            std::array<std::array<Sample,AsyncPcmMailbox::kMaxFrames>,2> original{};
            std::array<double,AsyncPcmMailbox::kMaxFrames> wetMix{};
            std::array<bool,AsyncPcmMailbox::kMaxFrames> bypass{};
            while(frames<AsyncPcmMailbox::kMaxFrames &&
                  start+static_cast<int32>(frames)<data.numSamples) {
                const int32 frame=start+static_cast<int32>(frames);
                std::array<bool,StreamHostEvents::kBindingCount> changed{};
                std::array<bool,64> changedGeneric{};
                uint32_t demand=0;
                if(frames>0) {
                    for(uint32_t k=0;k<StreamHostEvents::kBindingCount;k++) {
                        const Queue* q=streamQueues[k];
                        changed[k]=q&&q->next<q->count&&q->offset==frame;
                        if(changed[k])demand++;
                    }
                    if(auth) {
                        for(std::uint32_t bit=0;bit<64;bit++) {
                            if(!(auth->allowedMask&(std::uint64_t{1}<<bit)))continue;
                            const Queue* q=genericQueues[bit];
                            changedGeneric[bit]=q&&q->next<q->count&&q->offset==frame;
                            if(changedGeneric[bit])demand++;
                        }
                    }
                    if(!controls.hasRoom(demand))break;
                }
                apply(frame);
                if(frames==0) {
                    // Equivalent to all same-sample changes in host order:
                    // only final values can affect a continuously sampled DSP.
                    StreamHostEvents initial{};
                    if(!initial.start(values_,hostSampleRate_))
                        return kResultFalse;
                    for(std::uint32_t k=0;k<initial.count();k++) {
                        if(!controls.appendPhysical(initial.data()[k]))
                            return kResultFalse;
                    }
                    if(auth)for(std::uint32_t bit=0;bit<64;bit++){
                        if(!(auth->allowedMask&(std::uint64_t{1}<<bit)))continue;
                        if(!controls.append(auth->codec[bit],64u+bit,0,values_[64u+bit]))
                            return kResultFalse;
                    }
                }else{
                    for(uint32_t k=0;k<StreamHostEvents::kBindingCount;k++)if(changed[k]){
                        const uint32_t id=StreamHostEvents::idAt(k);
                        // Reuse the already-fixed physical registry; the
                        // builder enforces a shared capacity and finite PCM.
                        if(!controls.appendPhysical({
                              id,frames,physicalFromNormalized(
                                  kParams[id],values_[id],hostSampleRate_)}))
                            return kResultFalse;
                    }
                    if(auth)for(std::uint32_t bit=0;bit<64;bit++)if(changedGeneric[bit]){
                        if(!controls.append(auth->codec[bit],64u+bit,frames,
                                            values_[64u+bit]))return kResultFalse;
                    }
                }
                wetMix[frames]=values_[0];
                bypass[frames]=values_[1]>=0.5;
                for(int32 ch=0;ch<src.numChannels;ch++) {
                    const bool silent=(src.silenceFlags&(uint64(1)<<ch))!=0;
                    Sample sample{};
                    if(!silent){
                        if constexpr(std::is_same_v<Sample,Sample32>)
                            sample=src.channelBuffers32[ch][frame];
                        else sample=src.channelBuffers64[ch][frame];
                    }
                    original[ch][frames]=sample;
                    input[ch][frames]=static_cast<float>(sample);
                }
                frames++;
            }
            if(frames==0)return kResultFalse; // impossible: eighteen always fit
            uint64_t jobStart=0;
            if(hasWorker){
                jobStart=worker_.mailbox().rtNextTime();
                const float* inputs[2]={input[0].data(),input[1].data()};
                worker_.mailbox().rtSubmit(inputs,
                    static_cast<uint32_t>(src.numChannels),frames,
                    controls.data(),controls.count(),
                    auth?&packetAuth:nullptr);
            }
            for(uint32_t i=0;i<frames;i++) {
                float wet[2]{};
                AsyncPcmMailbox::AuthorizationTag wetAuth{};
                const bool arrived=hasWorker&&
                   worker_.mailbox().rtReadWet(jobStart+i,
                     static_cast<uint32_t>(src.numChannels),wet,&wetAuth);
                // Every tagged delayed wet sample must still own the current
                // worker permission; stale packets become delayed Dry.
                const bool available=arrived && (!wetAuth.ticket ||
                    worker_.genericAuthorization().rtTicketLive(wetAuth.ticket));
                for(int32 ch=0;ch<src.numChannels;ch++) {
                    const auto dry=delay_.tick(ch,original[ch][i]);
                    Sample output=dry;
                    if(available&&!bypass[i]) {
                        const double w=wetMix[i];
                        output=static_cast<Sample>(
                            static_cast<double>(dry)*(1.-w)+
                            static_cast<double>(wet[ch])*w);
                    }
                    if constexpr(std::is_same_v<Sample,Sample32>)
                        dst.channelBuffers32[ch][start+i]=output;
                    else dst.channelBuffers64[ch][start+i]=output;
                }
                delay_.next();
            }
            start+=static_cast<int32>(frames);
        }
        dst.silenceFlags=0; // never drop the buffered impulse tail
        parameterMailbox_.rtPublish(values_);
        return kResultOk;
    }
    tresult PLUGIN_API process(ProcessData& data) override {
        if(data.symbolicSampleSize==kSample32)return processTyped<Sample32>(data);
        if(data.symbolicSampleSize==kSample64)return processTyped<Sample64>(data);
        return kResultFalse;
    }
private:
    // Called only with projectStateMutex_ held on the NON-RT host thread.
    // Worker commits the logical project ledger BEFORE ticket publication;
    // this bridges exact current evidence to the existing FWS3 IBStream.
    bool absorbCommittedNewLedger() {
        if(!savedBindingLedger_.empty())return false;
        NativeWorkerService::PreparedNewLedger acceptedLedger{};
        if(!worker_.readCommittedNewLedger(acceptedLedger))return false;
        const auto snapshot=worker_.verifiedIdentitySnapshot();
        VerifiedProjectEngine verified{};
        verified.package=snapshot.package;
        verified.engineId=snapshot.engineId;
        verified.sha256=snapshot.packageSha256;
        verified.acceptedGeneration=snapshot.acceptedGeneration;
        verified.active=snapshot.active;
        GenericNewLedgerEvidence proof{};
        proof.requestId=acceptedLedger.requestId;
        proof.authorizedTicket=acceptedLedger.authorizedTicket;
        proof.acceptedGeneration=acceptedLedger.acceptedGeneration;
        proof.packageSha256=acceptedLedger.packageSha256;
        proof.authorizedMask=acceptedLedger.stagedAuthorization.allowedMask;
        proof.encodedLedger=acceptedLedger.encodedLedger;
        std::vector<std::uint8_t> selected{};
        if(!selectExplicitNewLedgerForCommit(
               proof,verified,proof.requestId,
               worker_.genericAuthorization().workerCurrentTicket(),
               proof.authorizedMask,savedBindingLedger_,true,selected))
            return false;
        savedBindingLedger_=std::move(selected);
        return true;
    }
    Values values_=defaults(); // RT-owned; never accessed by UI/getState
    ParameterStateMailbox<kParamCount> parameterMailbox_{defaults()};
    Delay delay_;
    NativeWorkerService worker_{}; // per-instance worker, never process()
    std::mutex projectStateMutex_{}; // GUI/host lifecycle only; never RT
    std::vector<uint8_t> savedBindingLedger_{}; // FWS3 intent, never DSP authority
    std::vector<uint8_t> deferredRestorePackage_{}; // non-RT only
    bool deferredRestorePending_=false,workerActive_=false;
    double hostSampleRate_=48000.;
    uint32 hostChannels_=2;
};
class Controller final:public EditController {
public:
    static FUnknown* createInstance(void*) {
        return static_cast<IEditController*>(new Controller);
    }
    tresult PLUGIN_API initialize(FUnknown* context) override {
        auto r=EditController::initialize(context);
        if(r!=kResultOk)return r;
        const auto def=defaults();
        for(uint32_t i=0;i<kParamCount;i++) {
            char generated[64]{};
            const Param* desc=findParam(i);
            const char* name=desc?desc->name:nullptr;
            if(!name) {
                std::snprintf(generated,sizeof(generated),
                    i<kEngineBegin ? "Reserved %02u":"Engine Slot %02u (unbound)",
                    static_cast<unsigned>(i));
                name=generated;
            }
            String128 title{},unit{};
            UString(title,128).fromAscii(name);
            if(desc)UString(unit,128).fromAscii(desc->unit);
            const int32 flags=i==1
               ? (ParameterInfo::kCanAutomate|ParameterInfo::kIsBypass)
               : (i>=kActiveCount&&i<kEngineBegin ? 0 : ParameterInfo::kCanAutomate);
            parameters.addParameter(title,desc?unit:nullptr,
                desc?static_cast<int32>(desc->steps):0,
                def[i],flags,static_cast<ParamID>(i));
        }
        return kResultOk;
    }
    // Host generic parameter readouts reflect canonical units, not rail position.
    // The plugin editor added in S3 must call beginEdit/performEdit/endEdit.
    tresult PLUGIN_API getParamStringByValue(ParamID id,ParamValue normalized,
        String128 result) override {
        const auto* p=findParam(id);
        if(!p)return EditController::getParamStringByValue(id,normalized,result);
        const auto physical=physicalFromNormalized(*p,normalized);
        char text[96]{};
        if(p->scale==Scale::Discrete) {
            const int v=static_cast<int>(std::lround(physical));
            if(const auto* title=discreteLabel(id,v))
                std::snprintf(text,sizeof(text),"%s",title);
            else
                std::snprintf(text,sizeof(text),"%d%s%s",
                    v,p->unit[0]?" ":"",p->unit);
        } else if(p->unit[0]=='%'&&p->unit[1]=='\0') {
            std::snprintf(text,sizeof(text),"%.3f %%",physical*100.);
        } else {
            std::snprintf(text,sizeof(text),"%.3f%s%s",
                physical,p->unit[0]?" ":"",p->unit);
        }
        UString(result,128).fromAscii(text);
        return kResultOk;
    }
    tresult PLUGIN_API getParamValueByString(ParamID id,TChar* input,
        ParamValue& normalized) override {
        const auto* p=findParam(id);
        if(!p)return EditController::getParamValueByString(id,input,normalized);
        if(!input)return kInvalidArgument;
        String text(input);
        double value=0.;
        if(!text.scanFloat(value)||!std::isfinite(value))return kResultFalse;
        if(p->unit[0]=='%'&&p->unit[1]=='\0')value/=100.;
        if(value<p->min||value>p->max)return kResultFalse;
        normalized=normalizedFromPhysical(*p,value);
        return kResultOk;
    }
    tresult PLUGIN_API setComponentState(IBStream* stream) override {
        Values v{};if(!readState(stream,v))return kResultFalse;
        for(ParamID id=0;id<kParamCount;id++)setParamNormalized(id,v[id]);
        return kResultOk;
    }
    // Controller sends one request at a time. Exactly matched worker request IDs
    // are required before any GUI calls a candidate ACTIVE or allows Back.
    uint64_t sendPackageToProcessor(const std::vector<uint8_t>& bytes) {
        if(bytes.empty()||bytes.size()>8*1024*1024)return 0;
        const uint64_t request=nextRequest_.fetch_add(1,std::memory_order_relaxed)+1;
        if(request>(UINT64_MAX>>1))return 0;
        uint64_t none=0;
        if(!inFlight_.compare_exchange_strong(none,request,
            std::memory_order_acq_rel))return 0;
        auto* msg=allocateMessage();
        if(!msg){inFlight_.store(0,std::memory_order_release);return 0;}
        msg->setMessageID("FrequencyWarp.LoadFwengineV1");
        auto* attrs=msg->getAttributes();
        const bool ok=attrs &&
            attrs->setInt("request",static_cast<int64>(request))==kResultTrue &&
            attrs->setBinary("package",bytes.data(),
                static_cast<uint32>(bytes.size()))==kResultTrue;
        const auto sent=ok?sendMessage(msg):kResultFalse;
        msg->release();
        if(sent!=kResultTrue){
            uint64_t id=request;
            inFlight_.compare_exchange_strong(id,0,std::memory_order_acq_rel);
            return 0;
        }
        return request;
    }
    // Future trusted native editor can invoke this non-RT transport only
    // for an EXISTING saved FWS3. The processor still independently denies
    // absent/mismatched ledgers and incomplete worker verification.
    uint64_t sendSavedGenericDescriptorToProcessor(
        const std::vector<uint8_t>& descriptor) {
        if(descriptor.empty() || descriptor.size()>kGenericUiDescriptorLimit ||
           !validGenericUiRequest(1,descriptor.data(),descriptor.size()))
            return 0;
        const uint64_t request=nextAuthRequest_.fetch_add(
            1,std::memory_order_relaxed)+1;
        if(request==0 || request>kGenericUiMaxRequest)return 0;
        uint64_t none=0;
        if(!genericInFlight_.compare_exchange_strong(
                none,request,std::memory_order_acq_rel))return 0;
        auto* msg=allocateMessage();
        if(!msg) {
            genericInFlight_.store(0,std::memory_order_release);
            return 0;
        }
        msg->setMessageID("FrequencyWarp.AuthorizeSavedGenericV1");
        auto* attrs=msg->getAttributes();
        const bool ok=attrs &&
            attrs->setInt("request",static_cast<int64>(request))==kResultTrue &&
            attrs->setBinary("descriptor",descriptor.data(),
                            static_cast<uint32>(descriptor.size()))==kResultTrue;
        const auto sent=ok?sendMessage(msg):kResultFalse;
        msg->release();
        if(sent!=kResultTrue) {
            uint64_t expected=request;
            genericInFlight_.compare_exchange_strong(
                expected,0,std::memory_order_acq_rel);
            return 0;
        }
        return request;
    }
    // D7B native Controller orchestration only. Trusted UI may call these
    // after an explicit user action; JavaScript never supplies a worker ID,
    // package SHA, or permission ticket. These are non-audio host messages.
    uint64_t sendPrepareNewGenericDescriptor(
        const std::vector<uint8_t>& descriptor) {
        if(!validGenericUiRequest(1,descriptor.data(),descriptor.size()))return 0;
        const auto request=nextNewRequest_.fetch_add(
            1,std::memory_order_relaxed)+1;
        if(request==0||request>kGenericUiMaxRequest)return 0;
        uint64_t empty=0;
        if(!newInFlight_.compare_exchange_strong(
               empty,request,std::memory_order_acq_rel))return 0;
        auto* msg=allocateMessage();
        if(!msg) {newInFlight_.store(0,std::memory_order_release);return 0;}
        msg->setMessageID("FrequencyWarp.PrepareNewGenericV1");
        auto* a=msg->getAttributes();
        const bool good=a &&
            a->setInt("request",static_cast<int64>(request))==kResultTrue &&
            a->setInt("explicit",1)==kResultTrue &&
            a->setBinary("descriptor",descriptor.data(),
                         static_cast<uint32>(descriptor.size()))==kResultTrue;
        const auto r=good?sendMessage(msg):kResultFalse;
        msg->release();
        if(r!=kResultTrue) {
            uint64_t expected=request;
            newInFlight_.compare_exchange_strong(
                expected,0,std::memory_order_acq_rel);
            return 0;
        }
        return request;
    }
    bool sendCommitNewGeneric(uint64_t request) {
        if(!request||newInFlight_.load(std::memory_order_acquire)!=request||
           lastNewPreparedWord_.load(std::memory_order_acquire)!=
               ((request<<1)|1u))return false;
        auto* msg=allocateMessage();
        if(!msg)return false;
        msg->setMessageID("FrequencyWarp.CommitNewGenericV1");
        auto* a=msg->getAttributes();
        const bool ok=a &&
            a->setInt("request",static_cast<int64>(request))==kResultTrue &&
            a->setInt("explicit",1)==kResultTrue;
        const auto r=ok?sendMessage(msg):kResultFalse;
        msg->release();
        if(r!=kResultTrue) {
            std::uint64_t expected=request;
            newInFlight_.compare_exchange_strong(
                expected,0,std::memory_order_acq_rel);
        }
        return r==kResultTrue;
    }
    void queryNewGenericStatus() {
        auto* msg=allocateMessage();
        if(!msg)return;
        msg->setMessageID("FrequencyWarp.QueryNewGenericV1");
        sendMessage(msg);
        msg->release();
    }
    bool lastNewGenericSavedSnapshot() const noexcept {
        return lastNewSaved_.load(std::memory_order_acquire);
    }
    bool lastNewGenericActiveSnapshot() const noexcept {
        return lastNewActive_.load(std::memory_order_acquire);
    }
    std::uint64_t currentVerifiedGenericUiMask() const noexcept {
        // Informational GUI authority is short-lived. RT and Worker still
        // independently verify each packet's live ticket/epoch.
        using Clock=std::chrono::steady_clock;
        const auto ms=std::chrono::duration_cast<std::chrono::milliseconds>(
            Clock::now().time_since_epoch()).count();
        const auto stamp=uiMaskVerifiedMs_.load(std::memory_order_acquire);
        if(stamp<=0||ms<stamp||ms-stamp>300)return 0;
        return lastUiMask_.load(std::memory_order_acquire);
    }
    // Query/ack remains on the VST3 host lifecycle, never from process().
    uint64_t lastSavedGenericAuthorizationWord() const noexcept {
        return lastSavedGenericStatus_.load(std::memory_order_acquire);
    }
    bool lastSavedGenericActiveSnapshot() const noexcept {
        return lastSavedGenericActive_.load(std::memory_order_acquire);
    }
    void querySavedGenericAuthorization() {
        auto* msg=allocateMessage();
        if(!msg)return;
        msg->setMessageID("FrequencyWarp.QuerySavedGenericV1");
        sendMessage(msg);
        msg->release();
    }
#ifdef _WIN32
    NewBindingStatus pollNewGenericStatus() {
        // Native UI poll is non-RT. An async processor query provides
        // correlated prepared/committed/saved/live status and can report a
        // safe engine-off state without aborting loaded original audio.
        queryNewGenericStatus();
        const auto prepared=lastNewPreparedWord_.load(std::memory_order_acquire);
        const auto committed=lastNewCommittedWord_.load(std::memory_order_acquire);
        return NewBindingStatus{
            prepared>>1,committed>>1,
            (prepared&1u)!=0,(committed&1u)!=0,
            lastNewSaved_.load(std::memory_order_acquire),
            lastNewActive_.load(std::memory_order_acquire)
        };
    }
    EngineStatusSnapshot pollWorkerStatus(){
        if(auto* message=allocateMessage()){
            message->setMessageID("FrequencyWarp.QueryEngineV1");
            sendMessage(message);
            message->release();
        }
        std::lock_guard<std::mutex> guard(snapshotMutex_);
        return lastSnapshot_;
    }
#endif
    tresult PLUGIN_API notify(IMessage* message) override {
        if(!message||!message->getMessageID())return kInvalidArgument;
        if(std::strcmp(message->getMessageID(),
                       "FrequencyWarp.NewGenericStatusV1")==0) {
            auto* a=message->getAttributes();
            if(!a)return kResultFalse;
            int64 preparedRequest=0,prepared=0,commitRequest=0,committed=0;
            int64 saved=0,active=0,lo=0,hi=0;
            if(a->getInt("maskLo",lo)!=kResultTrue ||
               a->getInt("maskHi",hi)!=kResultTrue ||
               lo<0||lo>UINT32_MAX||hi<0||hi>UINT32_MAX ||
               a->getInt("preparedRequest",preparedRequest)!=kResultTrue ||
               a->getInt("prepared",prepared)!=kResultTrue ||
               a->getInt("committedRequest",commitRequest)!=kResultTrue ||
               a->getInt("committed",committed)!=kResultTrue ||
               a->getInt("saved",saved)!=kResultTrue ||
               a->getInt("active",active)!=kResultTrue ||
               preparedRequest<0||commitRequest<0||
               (prepared!=0&&prepared!=1)||
               (committed!=0&&committed!=1)||
               (saved!=0&&saved!=1)||(active!=0&&active!=1)||
               (active&&!saved))return kResultFalse;
            const auto mask=static_cast<std::uint64_t>(lo) |
                (static_cast<std::uint64_t>(hi)<<32);
            if((active&&!mask)||(!active&&mask))return kResultFalse;
            lastUiMask_.store(active?mask:0,std::memory_order_release);
            const auto now=std::chrono::duration_cast<std::chrono::milliseconds>(
                std::chrono::steady_clock::now().time_since_epoch()).count();
            uiMaskVerifiedMs_.store(now,std::memory_order_release);
            lastNewPreparedWord_.store(
                (static_cast<uint64_t>(preparedRequest)<<1) |
                static_cast<uint64_t>(prepared),std::memory_order_release);
            lastNewCommittedWord_.store(
                (static_cast<uint64_t>(commitRequest)<<1) |
                static_cast<uint64_t>(committed),std::memory_order_release);
            lastNewSaved_.store(saved!=0,std::memory_order_release);
            lastNewActive_.store(active!=0,std::memory_order_release);
            const auto inFlight=newInFlight_.load(std::memory_order_acquire);
            if(inFlight && (static_cast<uint64_t>(commitRequest)==inFlight ||
               (static_cast<uint64_t>(preparedRequest)==inFlight && !prepared))) {
                auto expected=inFlight;
                newInFlight_.compare_exchange_strong(
                    expected,0,std::memory_order_acq_rel);
            }
            return kResultOk;
        }
        if(std::strcmp(message->getMessageID(),
                       "FrequencyWarp.SavedGenericStatusV1")==0) {
            auto* attrs=message->getAttributes();
            if(!attrs)return kResultFalse;
            int64 request=0,succeeded=0,active=0;
            if(attrs->getInt("request",request)!=kResultTrue ||
               attrs->getInt("succeeded",succeeded)!=kResultTrue ||
               attrs->getInt("active",active)!=kResultTrue ||
               request<0 || (succeeded!=0&&succeeded!=1) ||
               (active!=0&&active!=1) || (active && !succeeded))
                return kResultFalse;
            // The completed word is historical; the separate active bit is
            // informational only and must NOT bypass worker/RT authority.
            const auto word=(static_cast<uint64_t>(request)<<1) |
                            static_cast<uint64_t>(succeeded);
            lastSavedGenericStatus_.store(word,std::memory_order_release);
            lastSavedGenericActive_.store(active==1,std::memory_order_release);
            uint64_t pending=genericInFlight_.load(std::memory_order_acquire);
            if(pending && static_cast<uint64_t>(request)==pending)
                genericInFlight_.compare_exchange_strong(
                    pending,0,std::memory_order_acq_rel);
            return kResultOk;
        }
        if(std::strcmp(message->getMessageID(),"FrequencyWarp.EngineStatusV1")!=0)
            return EditController::notify(message);
        auto* attrs=message->getAttributes();
        if(!attrs)return kResultFalse;
        int64 request=0,succeeded=0,accepted=0,handled=0,state=0;
        if(attrs->getInt("request",request)!=kResultTrue||
           attrs->getInt("succeeded",succeeded)!=kResultTrue||
           attrs->getInt("accepted",accepted)!=kResultTrue||
           attrs->getInt("handled",handled)!=kResultTrue||
           attrs->getInt("status",state)!=kResultTrue||
           request<0||accepted<0||handled<0||state<0||state>6||
           (succeeded!=0&&succeeded!=1))return kResultFalse;
#ifdef _WIN32
        {
            std::lock_guard<std::mutex> guard(snapshotMutex_);
            lastSnapshot_=EngineStatusSnapshot{true,static_cast<uint64_t>(request),
                static_cast<uint64_t>(accepted),static_cast<uint64_t>(handled),
                succeeded==1,static_cast<uint32_t>(state)};
        }
#endif
        const auto pending=inFlight_.load(std::memory_order_acquire);
        if(pending>0&&(request==static_cast<int64>(pending)||state==0))
            inFlight_.store(0,std::memory_order_release);
        // A new engine generation must not leave an older pending binding
        // request stuck forever. Discard only Controller bookkeeping here;
        // the Worker separately revokes the old candidate/ticket.
        const auto prior=lastBindingEngineAccepted_.exchange(
            static_cast<std::uint64_t>(accepted),std::memory_order_acq_rel);
        if(state==0 || (prior!=0 &&
                        prior!=static_cast<std::uint64_t>(accepted))) {
            newInFlight_.store(0,std::memory_order_release);
            lastNewPreparedWord_.store(0,std::memory_order_release);
            lastNewCommittedWord_.store(0,std::memory_order_release);
            lastNewSaved_.store(false,std::memory_order_release);
            lastNewActive_.store(false,std::memory_order_release);
            lastUiMask_.store(0,std::memory_order_release);
            uiMaskVerifiedMs_.store(0,std::memory_order_release);
        }
        return kResultOk;
    }
    IPlugView* PLUGIN_API createView(FIDString type) override {
#ifdef _WIN32
        if(!type||std::strcmp(type,ViewType::kEditor)!=0)return nullptr;
#if defined(FW_ENABLE_WEBVIEW2)
        // Experimental only: default native picker/rollback editor remains
        // functional until embedded Web UI achieves feature parity.
        if(const char* enabled=std::getenv("FW_VST3_WEBVIEW2_PREVIEW");
           enabled && std::strcmp(enabled,"1")==0 &&
           Win32WebView2Editor::runtimeAvailable())
            return new Win32WebView2Editor(this,[this]() -> std::uint64_t {
                // An asynchronous host message refreshes permission; stale
                // snapshots time out fail-closed within 300ms. No GUI call
                // ever derives authority from local HTML or a raw WASM mask.
                queryNewGenericStatus();
                return currentVerifiedGenericUiMask();
            },[this](const std::vector<uint8_t>& descriptor){
                return sendPrepareNewGenericDescriptor(descriptor);
            },[this](uint64_t request){
                return sendCommitNewGeneric(request);
            },[this](){return pollNewGenericStatus();});
#endif
        return new Win32EngineEditor(this,[this](const std::vector<uint8_t>& bytes){
            return sendPackageToProcessor(bytes);
        },[this](){return pollWorkerStatus();},
        [this](const std::vector<uint8_t>& descriptor){
            return sendPrepareNewGenericDescriptor(descriptor);
        },[this](uint64_t request){
            return sendCommitNewGeneric(request);
        },[this](){return pollNewGenericStatus();});
#else
        (void)type;
        return nullptr;
#endif
    }
private:
    std::atomic<uint64_t> nextRequest_{0},inFlight_{0};
    std::atomic<uint64_t> nextAuthRequest_{0},genericInFlight_{0},
                          lastSavedGenericStatus_{0};
    std::atomic<bool> lastSavedGenericActive_{false};
    std::atomic<uint64_t> nextNewRequest_{0},newInFlight_{0},
                          lastNewPreparedWord_{0},lastNewCommittedWord_{0};
    std::atomic<bool> lastNewSaved_{false},lastNewActive_{false};
    std::atomic<std::uint64_t> lastBindingEngineAccepted_{0};
    std::atomic<std::uint64_t> lastUiMask_{0};
    std::atomic<std::int64_t> uiMaskVerifiedMs_{0};
#ifdef _WIN32
    std::mutex snapshotMutex_{};
    EngineStatusSnapshot lastSnapshot_{};
#endif
};
} // namespace fw

using namespace Steinberg;
using namespace Steinberg::Vst;
#define FW_VERSION "0.2.0"
BEGIN_FACTORY_DEF("KiNoTch.", "https://github.com/kinoko34077/frequency-warp-vst", "")
  DEF_CLASS2(INLINE_UID_FROM_FUID(fw::kProcessorCID),
    PClassInfo::kManyInstances,kVstAudioEffectClass,"Frequency Warp Shell",
    kDistributable,"Fx",FW_VERSION,kVstVersionString,fw::Processor::createInstance)
  DEF_CLASS2(INLINE_UID_FROM_FUID(fw::kControllerCID),
    PClassInfo::kManyInstances,kVstComponentControllerClass,"Frequency Warp Shell Controller",
    0,"",FW_VERSION,kVstVersionString,fw::Controller::createInstance)
END_FACTORY
