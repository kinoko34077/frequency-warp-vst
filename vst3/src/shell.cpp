// S3b4 Stage A: fixed VST3 host with bounded asynchronous wet/Dry fallback.
// Native Wasmi is NEVER called from the audio thread. Actual package loading is S3b4-B.
#include "delay.h"
#include "async_pcm_mailbox.h"
#include "native_engine_abi.h"
#include "native_worker_service.h"
#include "stream_host_events.h"
#include "win32_engine_editor.h"
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
static constexpr int32 kMagic=0x46575332, kSchema=1; // FWS2 state v1
using Values=std::array<double,kParamCount>;
static Values defaults() {
    return defaultHostValues();
}
static bool readState(IBStream* stream,Values& result) {
    if(!stream)return false;
    IBStreamer s(stream,kLittleEndian);
    int32 magic=0,version=0,count=0;
    if(!s.readInt32(magic)||!s.readInt32(version)||!s.readInt32(count)||
        magic!=kMagic||version!=kSchema||count!=static_cast<int32>(kParamCount))return false;
    Values values{};
    for(double& value:values)if(!s.readDouble(value)||!std::isfinite(value)||
        value<0.||value>1.)return false;
    result=values;return true; // atomic state validation before commit
}
static bool writeState(IBStream* stream,const Values& values) {
    if(!stream)return false;
    IBStreamer s(stream,kLittleEndian);
    if(!s.writeInt32(kMagic)||!s.writeInt32(kSchema)||
        !s.writeInt32(static_cast<int32>(kParamCount)))return false;
    for(double value:values)if(!s.writeDouble(value))return false;
    return true;
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
        // Host lifecycle is non-audio; setActive(false) requires quiescent
        // callbacks. Joining or spawning a Rust worker in process is forbidden.
        if(!active) {
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
        return writeState(stream,values_)?kResultOk:kResultFalse;
    }
    tresult PLUGIN_API setState(IBStream* stream) override {
        Values temp{};if(!readState(stream,temp))return kResultFalse;
        values_=temp;return kResultOk;
    }
    struct Queue {
        IParamValueQueue* queue=nullptr;
        ParamID id=0;
        int32 count=0,next=0,offset=0;
        ParamValue value=0;
    };
    template<class Sample> tresult processTyped(ProcessData& data) {
        if(data.numSamples<0)return kInvalidArgument;
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
        if(data.numSamples==0){apply(0);return kResultOk;}
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
        // Chunking is adaptive: each packet begins with four verified physical
        // parameter snapshots (so a newly loaded engine receives host state).
        // Up to 124 more distinct per-sample changes fit the fixed 128-event
        // ABI. If over capacity, split BEFORE consuming any host point.
        // No host automation changes are silently discarded.
        const bool hasWorker=worker_.mailbox().rtHasPreparedWorker();
        std::array<Queue*,StreamHostEvents::kBindingCount> streamQueues{};
        for(int32 q=0;q<used;q++){
            const int index=StreamHostEvents::indexOf(cursors[q].id);
            if(index>=0)streamQueues[static_cast<size_t>(index)]=&cursors[q];
        }
        for(int32 start=0;start<data.numSamples;) {
            uint32_t frames=0;
            StreamHostEvents controls{};
            std::array<std::array<float,AsyncPcmMailbox::kMaxFrames>,2> input{};
            std::array<std::array<Sample,AsyncPcmMailbox::kMaxFrames>,2> original{};
            std::array<double,AsyncPcmMailbox::kMaxFrames> wetMix{};
            std::array<bool,AsyncPcmMailbox::kMaxFrames> bypass{};
            while(frames<AsyncPcmMailbox::kMaxFrames &&
                  start+static_cast<int32>(frames)<data.numSamples) {
                const int32 frame=start+static_cast<int32>(frames);
                std::array<bool,StreamHostEvents::kBindingCount> changed{};
                uint32_t demand=0;
                if(frames>0) {
                    for(uint32_t k=0;k<StreamHostEvents::kBindingCount;k++) {
                        const Queue* q=streamQueues[k];
                        changed[k]=q&&q->next<q->count&&q->offset==frame;
                        if(changed[k])demand++;
                    }
                    if(!controls.hasRoom(demand))break;
                }
                apply(frame);
                if(frames==0) {
                    // Equivalent to all same-sample changes in host order:
                    // only final values can affect a continuously sampled DSP.
                    if(!controls.start(values_,hostSampleRate_))
                        return kResultFalse;
                }else{
                    for(uint32_t k=0;k<StreamHostEvents::kBindingCount;k++)if(changed[k]){
                        const uint32_t id=StreamHostEvents::idAt(k);
                        if(!controls.append(id,frames,values_[id],hostSampleRate_))
                            return kResultFalse;
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
            if(frames==0)return kResultFalse; // impossible: initial 11 always fit
            uint64_t jobStart=0;
            if(hasWorker){
                jobStart=worker_.mailbox().rtNextTime();
                const float* inputs[2]={input[0].data(),input[1].data()};
                worker_.mailbox().rtSubmit(inputs,
                    static_cast<uint32_t>(src.numChannels),frames,
                    controls.data(),controls.count());
            }
            for(uint32_t i=0;i<frames;i++) {
                float wet[2]{};
                const bool available=hasWorker&&
                   worker_.mailbox().rtReadWet(jobStart+i,
                     static_cast<uint32_t>(src.numChannels),wet);
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
        return kResultOk;
    }
    tresult PLUGIN_API process(ProcessData& data) override {
        if(data.symbolicSampleSize==kSample32)return processTyped<Sample32>(data);
        if(data.symbolicSampleSize==kSample64)return processTyped<Sample64>(data);
        return kResultFalse;
    }
private:
    Values values_=defaults();
    Delay delay_;
    NativeWorkerService worker_{}; // per-instance worker, never process()
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
#ifdef _WIN32
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
        return kResultOk;
    }
    IPlugView* PLUGIN_API createView(FIDString type) override {
#ifdef _WIN32
        if(!type||std::strcmp(type,ViewType::kEditor)!=0)return nullptr;
        return new Win32EngineEditor(this,[this](const std::vector<uint8_t>& bytes){
            return sendPackageToProcessor(bytes);
        },[this](){return pollWorkerStatus();});
#else
        (void)type;
        return nullptr;
#endif
    }
private:
    std::atomic<uint64_t> nextRequest_{0},inFlight_{0};
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
