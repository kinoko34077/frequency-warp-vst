// Windows VST3 S2 FIXED SHELL: delayed identity only. Swappable WASM runtime is S3.
#include "delay.h"
#include "parameter_registry.h"
#include "native_engine_abi.h"
#include "base/source/fstring.h"
#include "public.sdk/source/vst/vstaudioeffect.h"
#include "public.sdk/source/vst/vsteditcontroller.h"
#include "public.sdk/source/main/pluginfactory.h"
#include "base/source/fstreamer.h"
#include "pluginterfaces/base/ustring.h"
#include "pluginterfaces/vst/ivstparameterchanges.h"
#include "pluginterfaces/vst/vstspeaker.h"
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
        // Non-audio host lifecycle handshake, forcing real static Wasmi linkage.
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
        return kResultOk;
    }
    tresult PLUGIN_API setupProcessing(ProcessSetup& setup) override {
        if(!std::isfinite(setup.sampleRate)||setup.sampleRate<=0.0||
            setup.maxSamplesPerBlock<1)return kResultFalse;
        return AudioEffect::setupProcessing(setup);
    }
    tresult PLUGIN_API setActive(TBool active) override {
        delay_.reset();return AudioEffect::setActive(active);
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
        for(int32 frame=0;frame<data.numSamples;frame++) {
            apply(frame); // sample-accurate host state despite S2 dry-only engine
            for(int32 ch=0;ch<src.numChannels;ch++) {
                const bool silent=(src.silenceFlags&(uint64(1)<<ch))!=0;
                Sample input{};
                if(!silent) {
                    if constexpr(std::is_same_v<Sample,Sample32>)
                        input=src.channelBuffers32[ch][frame];
                    else input=src.channelBuffers64[ch][frame];
                }
                const auto output=delay_.tick(ch,input); // in-place safe
                if constexpr(std::is_same_v<Sample,Sample32>)
                    dst.channelBuffers32[ch][frame]=output;
                else dst.channelBuffers64[ch][frame]=output;
            }
            delay_.next();
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
    // S3 is responsible for dedicated file drop / Browse / Reload.
    IPlugView* PLUGIN_API createView(const char*) override {return nullptr;}
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
