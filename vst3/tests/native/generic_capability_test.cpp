#include "../../src/native_engine_abi.h"
#include "../../src/generic_numeric_codec.h"
#include <array>
#include <cmath>
#include <cstdint>
#include <fstream>
#include <iostream>
#include <limits>
#include <iterator>
#include <stdexcept>
#include <vector>
static std::vector<std::uint8_t> load(const char* file) {
    std::ifstream in(file,std::ios::binary);
    if(!in)throw std::runtime_error("cannot load fixture");
    return {std::istreambuf_iterator<char>(in),std::istreambuf_iterator<char>()};
}
static void expect(bool ok,const char* message) {
    if(!ok)throw std::runtime_error(message);
}
int main(int argc,char** argv) {
    try {
        expect(argc==4,"usage: generic-capability Identity Gain LegacyIdentity");
        auto identity=load(argv[1]),gain=load(argv[2]),legacy=load(argv[3]);
        auto* a=fw_native_prepare(identity.data(),identity.size(),48000.,2,128);
        auto* b=fw_native_prepare(gain.data(),gain.size(),48000.,2,128);
        auto* c=fw_native_prepare(legacy.data(),legacy.size(),48000.,2,128);
        expect(a&&b&&c,"all three legacy/v1-compatible packages prepared");
        expect(fw_native_generic_slot_mask(nullptr)==0,"null native mask must be zero");
        expect(fw_native_generic_slot_mask(a)==1&&fw_native_generic_slot_mask(b)==1,
               "demo engines must explicitly advertise slot64");
        expect(fw_native_generic_slot_mask(c)==0,
               "old demo missing optional export must be fail-closed");
        FWNativeGenericCodec attested{};
        expect(fw_native_copy_generic_codec(b,64,&attested),
               "verified Gain module must export canonical numeric contract");
        expect(attested.hostSlot==64 && attested.codecRevision==1 &&
               attested.scale==0 && attested.steps==0 &&
               attested.min==0. && attested.max==4. &&
               attested.defaultValue==0.5,
               "WASM-authored canonical linear gain range/codec");
        fw::GenericNumericCodec normalized{};
        normalized.hostSlot=attested.hostSlot;
        normalized.codecRevision=attested.codecRevision;
        normalized.scale=static_cast<fw::GenericScale>(attested.scale);
        normalized.steps=attested.steps;
        normalized.min=attested.min;
        normalized.max=attested.max;
        normalized.def=attested.defaultValue;
        double canonical=-1.;
        expect(fw::validGenericNumericCodec(normalized) &&
               fw::genericNormalizedToCanonical(normalized,.25,canonical) &&
               std::abs(canonical-1.)<1e-12,
               "C++ DAW codec must agree with validated WASM gain contract");
        const auto preserved=attested;
        expect(!fw_native_copy_generic_codec(c,64,&attested) &&
               !fw_native_copy_generic_codec(b,65,&attested) &&
               !fw_native_copy_generic_codec(nullptr,64,&attested) &&
               !fw_native_copy_generic_codec(b,64,nullptr) &&
               attested.hostSlot==preserved.hostSlot &&
               attested.max==preserved.max,
               "legacy/unknown/null codec lookups must fail atomically");
        expect(fw_native_generic_value_in_contract(a,64,0.0),
               "WASM-authored Identity gain zero must be allowed");
        expect(fw_native_generic_value_in_contract(b,64,4.0),
               "WASM-authored Gain maximum must be allowed");
        expect(!fw_native_generic_value_in_contract(b,64,-0.01) &&
               !fw_native_generic_value_in_contract(b,64,4.01),
               "out-of-range canonical generic values must be denied");
        expect(!fw_native_generic_value_in_contract(b,64,
                std::numeric_limits<double>::quiet_NaN()),
               "nonfinite generic value must be denied");
        expect(!fw_native_generic_value_in_contract(b,65,0.5) &&
               !fw_native_generic_value_in_contract(c,64,0.5) &&
               !fw_native_generic_value_in_contract(nullptr,64,0.5),
               "unattested or unsupported generic slot must remain inert");

        expect(fw_native_stream_control_mask(a)==0&&
               fw_native_stream_control_mask(c)==0,
               "demo engines cannot claim Stream fixed host semantics");
        std::array<float,256> pcm{},output{};
        pcm.fill(.8f);
        expect(fw_native_process(c,pcm.data(),output.data(),128,nullptr,0)==0,
               "legacy engine must still process audio with no generic edits");
        for(auto value:output)expect(std::abs(value-.8f)<1e-5f,
                                    "legacy identity output changed");
        const FWNativeEvent event{64,0,.25};
        expect(fw_native_process(c,pcm.data(),output.data(),128,&event,1)!=0,
               "unadvertised old generic slot must not be admitted by WASM");
        expect(fw_native_process(b,pcm.data(),output.data(),128,&event,1)==0,
               "explicitly advertised Gain slot64 must remain usable");
        for(auto value:output)expect(std::abs(value-.2f)<1e-5f,
                                    "advertised canonical gain result mismatch");
        fw_native_destroy(a);fw_native_destroy(b);fw_native_destroy(c);
        std::cout<<"PASS R3A generic capability bitmask, safe legacy fallback, demo PCM\n";
    } catch(const std::exception& error) {
        std::cerr<<"FAIL R3A: "<<error.what()<<"\n";return 1;
    }
    return 0;
}
