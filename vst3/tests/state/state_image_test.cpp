#include "../../src/engine_project_state.h"
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <limits>
#include <vector>
using fw::EngineProjectState;
static void check(bool test,const char* why){
    if(!test){std::fprintf(stderr,"S4c0 state FAIL: %s\n",why);std::abort();}
}
static std::vector<uint8_t> historicalV1(const EngineProjectState& image){
    std::vector<uint8_t> out;
    fw::state_detail::push32(out,EngineProjectState::kMagic);
    fw::state_detail::push32(out,1);
    fw::state_detail::push32(out,EngineProjectState::kCount);
    for(double value:image.values){
        std::uint64_t bits=0;std::memcpy(&bits,&value,8);
        fw::state_detail::push64(out,bits);
    }
    return out;
}
static bool sameImage(const EngineProjectState& a,const EngineProjectState& b){
    return a.values==b.values&&a.package==b.package&&
           a.bindingLedger==b.bindingLedger;
}
int main(){
    EngineProjectState first{};
    for(unsigned i=0;i<128;i++)first.values[i]=i/127.0;
    first.package={0x50,0x4b,0x03,0x04,0x01,0xab,0x00,0xff};
    const auto original=fw::encodeEngineProjectState(first);
    check(original.size()==EngineProjectState::kMinV2Size+first.package.size(),
          "exact v2 byte length");
    check(fw::state_detail::get32(original.data(),4)==2,
          "v2 schema marker");
    check(original==fw::encodeEngineProjectState(first),"deterministic encoding");
    EngineProjectState restored{};
    check(fw::decodeEngineProjectState(original.data(),original.size(),restored),
          "v2 decode");
    check(sameImage(first,restored),"exact normalized bits and archive bytes");
    check(!fw::decodeEngineProjectState(nullptr,original.size(),restored),"null refused");
    check(!fw::decodeEngineProjectState(original.data(),original.size()-1,restored),
          "truncated payload refused, even if crc bytes remain");
    check(sameImage(first,restored),"failed decode leaves destination intact");

    auto mutated=original;
    mutated[EngineProjectState::kLegacySize+4]^=0x80;
    check(!fw::decodeEngineProjectState(mutated.data(),mutated.size(),restored),
          "corrupted package rejected by CRC");
    check(sameImage(first,restored),"corrupt package does not overwrite current");
    mutated=original;mutated[20]^=0x80;
    check(!fw::decodeEngineProjectState(mutated.data(),mutated.size(),restored),
          "corrupt numeric body rejected");
    mutated=original;mutated[4]=3;
    check(!fw::decodeEngineProjectState(mutated.data(),mutated.size(),restored),
          "unknown future schema refused");
    mutated=original;mutated[8]=127;
    check(!fw::decodeEngineProjectState(mutated.data(),mutated.size(),restored),
          "wrong ParamID slot count refused");
    mutated=original;mutated[EngineProjectState::kLegacySize]=0xff;
    mutated[EngineProjectState::kLegacySize+1]=0xff;
    mutated[EngineProjectState::kLegacySize+2]=0xff;
    mutated[EngineProjectState::kLegacySize+3]=0xff;
    check(!fw::decodeEngineProjectState(mutated.data(),mutated.size(),restored),
          "absurd claimed module size refused");

    const auto legacy=historicalV1(first);
    check(legacy.size()==EngineProjectState::kLegacySize,"legacy exact size");
    check(fw::decodeEngineProjectState(legacy.data(),legacy.size(),restored),
          "v1 backward compatibility");
    check(restored.values==first.values&&restored.package.empty(),
          "v1 params restored without fabricating module identity");

    EngineProjectState empty=first;empty.package.clear();
    const auto noModule=fw::encodeEngineProjectState(empty);
    check(noModule.size()==EngineProjectState::kMinV2Size,
          "v2 no-engine image");
    check(fw::decodeEngineProjectState(noModule.data(),noModule.size(),restored)
          &&sameImage(empty,restored),"no-engine project roundtrip");

    // R2B optional V3 state: one engine-scoped generic slot binding.
    // Existing v1/v2 byte layout remains unchanged until project
    // activation+controller support is separately accepted in R2C/R3.
    fw::SlotBindingIdentity bind{};
    bind.hostSlot=64;
    bind.codecRevision=1;
    bind.engineId="org.example.engine";
    bind.semanticId="gain";
    bind.packageSha256.fill(0x42);
    fw::SlotBindingLedger ledger{{bind}};
    EngineProjectState v3=first;
    v3.bindingLedger=fw::encodeBindingLedger(ledger);
    const auto newFormat=fw::encodeEngineProjectState(v3);
    check(fw::state_detail::get32(newFormat.data(),4)==EngineProjectState::kV3,
          "V3 marker only with explicit verified-shaped semantic identity");
    EngineProjectState decodedV3{};
    check(fw::decodeEngineProjectState(newFormat.data(),newFormat.size(),decodedV3)
          &&sameImage(v3,decodedV3),"V3 exact project bytes and semantic binding restored");
    check(newFormat==fw::encodeEngineProjectState(v3),
          "deterministic V3 project image");
    auto corruptV3=newFormat;
    corruptV3[EngineProjectState::kLegacySize+4+v3.package.size()+8]^=0xff;
    check(!fw::decodeEngineProjectState(corruptV3.data(),corruptV3.size(),decodedV3),
          "corrupted nested identity rejected");
    check(sameImage(v3,decodedV3),"V3 rejection preserves active image atomically");
    corruptV3=newFormat;
    const auto identityLenOffset=EngineProjectState::kLegacySize+4+v3.package.size();
    corruptV3[identityLenOffset]=0xff;
    corruptV3[identityLenOffset+1]=0xff;
    corruptV3[identityLenOffset+2]=0xff;
    corruptV3[identityLenOffset+3]=0xff;
    check(!fw::decodeEngineProjectState(corruptV3.data(),corruptV3.size(),decodedV3),
          "absurd identity length rejected before access");
    check(!fw::decodeEngineProjectState(newFormat.data(),newFormat.size()-1,decodedV3),
          "truncated V3 cannot change destination");
    check(sameImage(v3,decodedV3),"truncated V3 remains atomic");
    EngineProjectState noEngineBinding=v3;
    noEngineBinding.package.clear();
    bool v3Threw=false;
    try{(void)fw::encodeEngineProjectState(noEngineBinding);}
    catch(const std::invalid_argument&){v3Threw=true;}
    check(v3Threw,"binding without engine archive forbidden");
    EngineProjectState invalidBinding=v3;
    invalidBinding.bindingLedger[invalidBinding.bindingLedger.size()-1]^=0xff;
    v3Threw=false;
    try{(void)fw::encodeEngineProjectState(invalidBinding);}
    catch(const std::invalid_argument&){v3Threw=true;}
    check(v3Threw,"corrupt nested binding image must not be serialized");
    check(fw::state_detail::get32(original.data(),4)==EngineProjectState::kV2,
          "existing V2 image did not migrate automatically");

    EngineProjectState maxPackage=empty;
    maxPackage.package.resize(EngineProjectState::kMaxPackage,0xc3);
    const auto maxImage=fw::encodeEngineProjectState(maxPackage);
    check(fw::decodeEngineProjectState(maxImage.data(),maxImage.size(),restored)
          &&sameImage(maxPackage,restored),"8 MiB package cap works");
    maxPackage.package.push_back(0xff);
    bool threw=false;
    try{(void)fw::encodeEngineProjectState(maxPackage);}
    catch(const std::invalid_argument&){threw=true;}
    check(threw,"oversized image rejected before allocation");
    first.values[4]=std::numeric_limits<double>::quiet_NaN();
    threw=false;
    try{(void)fw::encodeEngineProjectState(first);}
    catch(const std::invalid_argument&){threw=true;}
    check(threw,"nonfinite host parameter rejected");
    std::puts("PASS S4c0 state: v1 compatible, deterministic v2, 128 slots, 8MiB, CRC and atomic failure");
}
