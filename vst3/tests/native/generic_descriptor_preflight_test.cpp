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
        hash+R"("},"bindings":[{"host_slot":64,"semantic_id":"gain","label":"Gain","dimension":"signedRatio","canonical_unit":"ratio","min":0,"max":4,"default":0.5,"scale":"linear","widget":"knob","display_units":[)"+
        "\""+unit+"\""+R"(],"codec_revision":1,"snap":{"values":[0,0.5,1],"radius_normalized":0.03}}]})";
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
        // R3C2D2: whole-document gate is all-or-nothing. A valid slot64
        // alone cannot conceal a foreign/undefined 2nd slot in a UI file.
        std::uint64_t attestedMask=0xabcdu;
        auto attest=[&](const std::string& document)->bool {
            return fw_native_attest_generic_descriptor_set(
                g,reinterpret_cast<const std::uint8_t*>(document.data()),
                document.size(),&attestedMask);
        };
        const auto valid=doc(hashHex(digest));
        require(attest(valid)&&attestedMask==1u,
                "real Gain whole-descriptor attestation rejected");
        auto invalidExtra=valid.substr(0,valid.size()-2) +
            R"(,{"host_slot":65,"semantic_id":"extra","label":"Extra","dimension":"signedRatio","canonical_unit":"ratio","min":0,"max":4,"default":0.5,"scale":"linear","widget":"knob","display_units":["ratio"],"codec_revision":1}]})";
        attestedMask=0xabcdu;
        require(!attest(invalidExtra)&&attestedMask==0xabcdu,
                "foreign extra UI binding must deny ALL, preserving output");
        auto invalidRange=valid;
        auto maxPos=invalidRange.find("\"max\":4");
        require(maxPos!=std::string::npos,"range fixture mismatch");
        invalidRange.replace(maxPos,7,"\"max\":3");
        require(!attest(invalidRange)&&attestedMask==0xabcdu,
                "mismatched WASM canonical range was accepted");
        auto invalidSemantic=valid;
        auto semPos=invalidSemantic.find("\"semantic_id\":\"gain\"");
        require(semPos!=std::string::npos,"semantic fixture mismatch");
        invalidSemantic.replace(semPos,20,"\"semantic_id\":\"fake\"");
        require(!attest(invalidSemantic)&&attestedMask==0xabcdu,
                "foreign UI semantic identity was accepted");
        require(!attest(doc(std::string(64,'0')))&&attestedMask==0xabcdu,
                "wrong package SHA must deny");
        require(!fw_native_attest_generic_descriptor_set(
            i,reinterpret_cast<const std::uint8_t*>(valid.data()),valid.size(),
            &attestedMask) && attestedMask==0xabcdu,
            "foreign native engine incorrectly accepted");
        require(!fw_native_attest_generic_descriptor_set(
            l,reinterpret_cast<const std::uint8_t*>(valid.data()),valid.size(),
            &attestedMask) && attestedMask==0xabcdu,
            "legacy unadvertised native contract incorrectly accepted");
        require(!fw_native_attest_generic_descriptor_set(
            g,nullptr,valid.size(),&attestedMask) && attestedMask==0xabcdu,
            "missing JSON input must preserve mask");
        require(!fw_native_attest_generic_descriptor_set(
            g,reinterpret_cast<const std::uint8_t*>(valid.data()),65537,
            &attestedMask) && attestedMask==0xabcdu,
            "oversized JSON must deny prior to read");
        require(!fw_native_attest_generic_descriptor_set(
            g,reinterpret_cast<const std::uint8_t*>(valid.data()),valid.size(),
            nullptr),"null mask output must deny");

        // Canonical semantic ID must come from the *live module*, not a
        // user-controlled descriptor's name. Read-only and non-RT.
        std::array<std::uint8_t,129> actualSemantic{};
        const auto semLen=fw_native_copy_generic_semantic_id(
            g,64,actualSemantic.data(),actualSemantic.size());
        require(semLen==4 &&
                std::string(reinterpret_cast<const char*>(actualSemantic.data()),semLen)=="gain" &&
                actualSemantic[semLen]==0,"real WASM semantic ID is not gain");
        std::array<std::uint8_t,129> unchanged{};
        unchanged.fill(0x66);
        require(fw_native_copy_generic_semantic_id(g,64,unchanged.data(),4)==0 &&
                unchanged[0]==0x66 && unchanged[4]==0x66,
                "short semantic buffer must stay untouched");
        require(fw_native_copy_generic_semantic_id(g,65,unchanged.data(),unchanged.size())==0,
                "undeclared slot65 semantic ID leaked");
        // The Identity demo intentionally advertises the SAME semantic
        // token "gain" with a different canonical default and engine ID.
        // A name match alone cannot authorize a foreign saved FWS3 project.
        const auto otherLen=fw_native_copy_generic_semantic_id(
            i,64,unchanged.data(),unchanged.size());
        require(otherLen==4 &&
                std::string(reinterpret_cast<const char*>(unchanged.data()),otherLen)=="gain",
                "Identity demo canonical semantic ID mismatch");
        require(fw_native_copy_generic_semantic_id(l,64,unchanged.data(),unchanged.size())==0,
                "legacy module semantic ID leaked");
        require(fw_native_copy_generic_semantic_id(nullptr,64,unchanged.data(),unchanged.size())==0,
                "null native semantic handle incorrectly accepted");
        require(fw_native_copy_generic_semantic_id(g,64,nullptr,unchanged.size())==0,
                "null semantic destination incorrectly accepted");
        require(check(g,valid),"valid engine-bound descriptor rejected");
        // Same verified file hash and declared slot are NOT enough:
        // every canonical parameter field must match WASM-owned bytes.
        auto mismatchMax=valid;
        mismatchMax.replace(mismatchMax.find("\"max\":4"),7,"\"max\":3");
        require(!check(g,mismatchMax),"WASM canonical max disagreement passed");
        auto mismatchDefault=valid;
        mismatchDefault.replace(mismatchDefault.find("\"default\":0.5"),13,"\"default\":1.0");
        require(!check(g,mismatchDefault),"WASM initial/default disagreement passed");
        auto mismatchScale=valid;
        mismatchScale.replace(mismatchScale.find("\"scale\":\"linear\""),16,"\"scale\":\"log\"");
        require(!check(g,mismatchScale),"WASM canonical scale disagreement passed");
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
        const auto* validBytes=reinterpret_cast<const std::uint8_t*>(valid.data());
        require(fw_native_attest_generic_descriptor_mask(g,validBytes,valid.size())==1,
                "whole canonical Gain descriptor must produce exact slot64 mask");
        require(fw_native_attest_generic_descriptor_mask(
                    g,reinterpret_cast<const std::uint8_t*>(mismatchMax.data()),
                    mismatchMax.size())==0,
                "whole descriptor must deny mismatched WASM maximum");
        require(fw_native_attest_generic_descriptor_mask(
                    g,reinterpret_cast<const std::uint8_t*>(mismatchDefault.data()),
                    mismatchDefault.size())==0,
                "whole descriptor must deny mismatched WASM default");
        require(fw_native_attest_generic_descriptor_mask(
                    g,reinterpret_cast<const std::uint8_t*>(mismatchScale.data()),
                    mismatchScale.size())==0,
                "whole descriptor must deny mismatched scale");
        require(fw_native_attest_generic_descriptor_mask(i,validBytes,valid.size())==0,
                "foreign module cannot attest a Gain package descriptor");
        require(fw_native_attest_generic_descriptor_mask(l,validBytes,valid.size())==0,
                "legacy module has no attested generic descriptor mask");
        auto extraSlot=valid;
        const auto bindStart=extraSlot.find("{\"host_slot\":64");
        const auto bindEnd=extraSlot.rfind("]}");
        require(bindStart!=std::string::npos && bindEnd!=std::string::npos &&
                bindEnd>bindStart,"whole descriptor test fixture layout");
        auto additional=extraSlot.substr(bindStart,bindEnd-bindStart);
        const auto hostPos=additional.find("\"host_slot\":64");
        const auto otherSemPos=additional.find("\"semantic_id\":\"gain\"");
        require(hostPos!=std::string::npos && otherSemPos!=std::string::npos,
                "whole descriptor required binding fields");
        additional.replace(otherSemPos,20,"\"semantic_id\":\"other\"");
        additional.replace(hostPos,14,"\"host_slot\":65");
        extraSlot.insert(bindEnd,","+additional);
        require(fw_native_attest_generic_descriptor_mask(
                   g,reinterpret_cast<const std::uint8_t*>(extraSlot.data()),
                   extraSlot.size())==0,
                "whole descriptor must reject undeclared extra slot");
        require(fw_native_attest_generic_descriptor_mask(nullptr,validBytes,valid.size())==0 &&
                fw_native_attest_generic_descriptor_mask(g,nullptr,valid.size())==0 &&
                fw_native_attest_generic_descriptor_mask(g,validBytes,65537)==0,
                "missing or oversized descriptor must fail before memory access");
        fw_native_destroy(g);fw_native_destroy(i);fw_native_destroy(l);
        std::cout<<"R3B2 PASS: exact worker descriptor preflight, units, bounds, legacy denial\n";
    }catch(const std::exception& e){
        std::cerr<<"R3B2 FAIL: "<<e.what()<<'\n';return 1;
    }
}
