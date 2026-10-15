#include "../../src/native_engine_abi.h"
#include <array>
#include <cstdint>
#include <fstream>
#include <iostream>
#include <iterator>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>
static void require(bool condition,const char* error){
    if(!condition)throw std::runtime_error(error);
}
static std::vector<std::uint8_t> read(const char* filename){
    std::ifstream file(filename,std::ios::binary);
    require(file.good(),"engine test archive missing");
    return {std::istreambuf_iterator<char>(file),std::istreambuf_iterator<char>()};
}
static std::string hashHex(const std::array<std::uint8_t,32>& bytes){
    static constexpr char digits[]="0123456789abcdef";
    std::string s;
    s.reserve(64);
    for(const auto x:bytes){s.push_back(digits[x>>4]);s.push_back(digits[x&15]);}
    return s;
}
static std::string doc(const std::string& hash,const std::string& unit="ratio"){
    // Same v1 outer schema as the unchanged website-side validator.
    return std::string(R"({"schema":"frequency-warp-ui-descriptors-v1","engine":{"id":"org.kinotch.gainhalf","version":"0.1.0","sha256":")")+
        hash+R"("},"bindings":[{"host_slot":64,"semantic_id":"gain","label":"Gain","dimension":"ratio","canonical_unit":"ratio","min":0.25,"max":4,"default":1,"scale":"log","widget":"knob","display_units":[)"+
        "\""+unit+"\""+R"(],"codec_revision":1,"snap":{"values":[0.5,1,2],"radius_normalized":0.03}}]})";
}
static bool check(const FWNativeOpaque* h,const std::string& json,
                  unsigned slot=64,const std::string& semantic="gain",
                  unsigned codec=1){
    return fw_native_preflight_generic_descriptor(
        h,reinterpret_cast<const std::uint8_t*>(json.data()),json.size(),
        slot,reinterpret_cast<const std::uint8_t*>(semantic.data()),semantic.size(),codec);
}
int main(int argc,char** argv){
    try{
        require(argc==4,"expected Gain, Identity, legacy-no-export .fwengine archives");
        const auto gain=read(argv[1]);
        const auto identity=read(argv[2]);
        const auto legacy=read(argv[3]);
        FWNativeOpaque* g=fw_native_prepare(gain.data(),gain.size(),48000.,2,128);
        FWNativeOpaque* i=fw_native_prepare(identity.data(),identity.size(),48000.,2,128);
        FWNativeOpaque* l=fw_native_prepare(legacy.data(),legacy.size(),48000.,2,128);
        require(g&&i&&l,"native worker failed to prepare test engines");
        std::array<std::uint8_t,32> digest{};
        std::array<std::uint8_t,129> engineName{};
        const auto len=fw_native_copy_verified_identity(
            g,digest.data(),digest.size(),engineName.data(),engineName.size());
        require(std::string(reinterpret_cast<const char*>(engineName.data()),len)=="org.kinotch.gainhalf",
                "expected verified Gain fixture ID");
        const auto valid=doc(hashHex(digest));
        require(check(g,valid),"valid engine-bound descriptor rejected");
        require(!check(i,valid),"foreign engine ID passed");
        require(!check(l,valid),"legacy engine missing mask passed");
        require(!check(g,doc(std::string(64,'0'))),"mismatched engine bytes passed");
        require(!check(g,doc(hashHex(digest),"hz")),"incompatible canonical dimension passed");
        require(!check(g,valid,65),"unadvertised slot65 passed");
        require(!check(g,valid,64,"other"),"foreign semantic id passed");
        require(!check(g,valid,64,"gain",2),"codec revision mismatch passed");
        require(!check(g,valid+"{}"),"trailing data passed");
        require(!check(nullptr,valid),"missing native engine passed");
        require(!fw_native_preflight_generic_descriptor(
            g,nullptr,10,64,reinterpret_cast<const std::uint8_t*>("gain"),4,1),
            "missing json buffer passed");
        require(!fw_native_preflight_generic_descriptor(
            g,reinterpret_cast<const std::uint8_t*>(valid.data()),valid.size(),
            64,nullptr,4,1),"missing semantic buffer passed");
        require(!fw_native_preflight_generic_descriptor(
            g,reinterpret_cast<const std::uint8_t*>(valid.data()),65537,
            64,reinterpret_cast<const std::uint8_t*>("gain"),4,1),
            "oversized descriptor passed before access");
        fw_native_destroy(g);fw_native_destroy(i);fw_native_destroy(l);
        std::cout<<"R3B2 PASS: exact worker descriptor preflight, units, bounds, legacy denial\n";
    }catch(const std::exception& e){
        std::cerr<<"R3B2 FAIL: "<<e.what()<<'\n';return 1;
    }
}
