#include "../../src/native_engine_abi.h"
#include <array>
#include <cmath>
#include <cstdint>
#include <fstream>
#include <iostream>
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
