#include "../../src/project_state_stream_reader.h"
#include "../../src/project_binding_association.h"
#include <cstring>
#include <cstdio>
#include <cstdlib>
#include <vector>
static void require(bool b,const char* detail) {
    if(!b){std::fprintf(stderr,"R2C3B stream FAIL: %s\n",detail);std::abort();}
}
struct Reader {
    const std::vector<uint8_t>& bytes;
    std::size_t pos=0;
    unsigned calls=0;
    bool operator()(void* dst,std::size_t count) {
        ++calls;
        if(count>bytes.size()-pos)return false;
        if(count)std::memcpy(dst,bytes.data()+pos,count);
        pos+=count;return true;
    }
};
static bool eq(const fw::EngineProjectState& a,const fw::EngineProjectState& b) {
    return a.values==b.values && a.package==b.package &&
           a.bindingLedger==b.bindingLedger;
}
static std::vector<uint8_t> legacy(const fw::EngineProjectState& s) {
    std::vector<uint8_t> bytes{};
    fw::state_detail::push32(bytes,fw::EngineProjectState::kMagic);
    fw::state_detail::push32(bytes,fw::EngineProjectState::kV1);
    fw::state_detail::push32(bytes,fw::EngineProjectState::kCount);
    for(double n:s.values){
        std::uint64_t bits=0;std::memcpy(&bits,&n,8);
        fw::state_detail::push64(bytes,bits);
    }
    return bytes;
}
int main() {
    fw::EngineProjectState old{};
    old.values.fill(.25);
    old.package={1,2,3,4,5};
    for(const auto& bytes:{legacy(old),fw::encodeEngineProjectState(old)}) {
        Reader stream{bytes};
        fw::EngineProjectState decoded{};
        require(fw::readProjectStateStream(stream,decoded),"old state read");
        require(decoded.values==old.values,"old values unchanged");
        require(decoded.package==(bytes.size()==fw::EngineProjectState::kLegacySize
                                    ?std::vector<uint8_t>{}:old.package),
                "old embedded engine preserved");
        require(decoded.bindingLedger.empty(),"old project cannot acquire new identity");
    }
    fw::SlotBindingIdentity bind{};
    bind.hostSlot=64;bind.codecRevision=1;
    bind.engineId="org.example.engine";bind.semanticId="gain";
    bind.packageSha256.fill(0x9a);
    fw::EngineProjectState v3=old;
    v3.bindingLedger=fw::encodeBindingLedger(fw::SlotBindingLedger{{bind}});
    const auto bytes=fw::encodeEngineProjectState(v3);
    Reader reader{bytes};
    fw::EngineProjectState decoded{};
    require(fw::readProjectStateStream(reader,decoded)&&eq(decoded,v3),
            "V3 exact module and ledger streaming");
    require(reader.pos==bytes.size(),"V3 read length exact");
    fw::VerifiedProjectEngine worker{};
    worker.package=v3.package;
    worker.sha256=bind.packageSha256;
    worker.engineId=bind.engineId;worker.acceptedGeneration=2;
    require(fw::matchSavedBindingToVerifiedEngine(decoded,worker),
            "loaded V3 identity matches accepted worker image");
    worker.engineId="org.example.other";
    require(!fw::matchSavedBindingToVerifiedEngine(decoded,worker),
            "loaded V3 ledger cannot rebind to unrelated engine");

    for(std::size_t i=0;i<bytes.size();++i){
        std::vector<uint8_t> truncated(bytes.begin(),bytes.begin()+i);
        Reader input{truncated};
        fw::EngineProjectState untouched=v3;
        require(!fw::readProjectStateStream(input,untouched),
                "truncated V3 input rejected");
        require(eq(untouched,v3),"truncated input cannot modify destination");
    }
    auto damaged=bytes;
    damaged[damaged.size()-1]^=0x7e;
    Reader corrupt{damaged};
    fw::EngineProjectState sentinel=v3;
    require(!fw::readProjectStateStream(corrupt,sentinel)&&eq(sentinel,v3),
            "CRC failure atomic");
    damaged=bytes;
    damaged[4]=4; // future version must not parse
    Reader future{damaged};
    require(!fw::readProjectStateStream(future,sentinel)&&eq(sentinel,v3),
            "unknown future schema rejected");
    damaged=bytes;
    const auto lenPos=fw::EngineProjectState::kLegacySize+4+v3.package.size();
    for(unsigned k=0;k<4;k++)damaged[lenPos+k]=0xff;
    Reader absurd{damaged};
    require(!fw::readProjectStateStream(absurd,sentinel)&&eq(sentinel,v3),
            "oversize claimed binding length rejected before allocation");
    damaged=bytes;
    const auto packagePos=fw::EngineProjectState::kLegacySize;
    for(unsigned k=0;k<4;k++)damaged[packagePos+k]=0xff;
    Reader huge{damaged};
    require(!fw::readProjectStateStream(huge,sentinel)&&eq(sentinel,v3),
            "unbounded archive length rejected before allocation");
    std::puts("PASS R2C3B: FWS1/V2/V3 stream, partial, CRC, bounds, verified identity");
}
