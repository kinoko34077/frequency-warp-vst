#pragma once
// UI-4B / R2A: non-RT, bounded portable persisted binding-identity codec.
// Does NOT activate an engine or change historical FWS1/FWS2 state bytes.
// Stage R2B will embed this image in a versioned project-state envelope.
#include <array>
#include <algorithm>
#include <cstdint>
#include <limits>
#include <set>
#include <stdexcept>
#include <string>
#include <vector>
#include <utility>

namespace fw {
struct SlotBindingIdentity {
    std::uint32_t hostSlot=0; // fixed DAW ParamID, 64..127 only
    std::uint32_t codecRevision=0;
    std::string engineId;
    std::string semanticId;
    // Full verified PACKAGE byte hash; a SHA is identity, NOT a signature.
    std::array<std::uint8_t,32> packageSha256{};
};
inline bool operator==(const SlotBindingIdentity& a,
                       const SlotBindingIdentity& b) noexcept {
    return a.hostSlot==b.hostSlot &&
           a.codecRevision==b.codecRevision &&
           a.engineId==b.engineId && a.semanticId==b.semanticId &&
           a.packageSha256==b.packageSha256;
}
struct SlotBindingLedger {
    std::vector<SlotBindingIdentity> bindings;
};
namespace binding_detail {
inline bool legalName(const std::string& s,bool dotted) {
    if(s.empty()||s.size()>128||s[0]<'a'||s[0]>'z')return false;
    bool hasSeparator=false;
    bool lastSeparator=false;
    for(unsigned char c:s){
        const bool alpha=(c>='a'&&c<='z')||(c>='0'&&c<='9');
        const bool sep=c=='.'||c=='-'||(!dotted&&c=='_');
        if(!alpha&&!sep)return false;
        if(sep) {
            if(lastSeparator)return false;
            hasSeparator=true;
        }
        lastSeparator=sep;
    }
    if(lastSeparator)return false;
    return !dotted||hasSeparator;
}
inline bool legal(const SlotBindingIdentity& b) {
    return b.hostSlot>=64 && b.hostSlot<=127 &&
        b.codecRevision>=1 && b.codecRevision<=65535 &&
        legalName(b.engineId,true) && legalName(b.semanticId,false);
}
inline std::uint32_t crc32(const std::uint8_t* data,std::size_t size) noexcept {
    std::uint32_t c=0xffffffffu;
    for(std::size_t i=0;i<size;++i) {
        c^=data[i];
        for(unsigned k=0;k<8;++k)
            c=(c>>1)^((c&1u)?0xedb88320u:0);
    }
    return c^0xffffffffu;
}
inline void push32(std::vector<std::uint8_t>& v,std::uint32_t x) {
    for(unsigned i=0;i<4;++i)v.push_back(static_cast<std::uint8_t>(x>>(8*i)));
}
inline bool pop32(const std::uint8_t* data,std::size_t size,std::size_t& pos,
                  std::uint32_t& out) noexcept {
    if(size-pos<4)return false;
    out=0;
    for(unsigned i=0;i<4;++i)out|=std::uint32_t(data[pos+i])<<(8*i);
    pos+=4;return true;
}
} // namespace binding_detail
inline bool validBindingLedger(const SlotBindingLedger& ledger) {
    if(ledger.bindings.size()>64)return false;
    std::set<std::uint32_t> slots;
    std::set<std::pair<std::string,std::string>> semanticIds;
    for(const auto& b:ledger.bindings) {
        if(!binding_detail::legal(b) || !slots.insert(b.hostSlot).second ||
           !semanticIds.insert({b.engineId,b.semanticId}).second)return false;
    }
    return true;
}
// Serialized v1 identity section: magic FWBI, version1, count0..64;
// per record: slot u32, codec u32, engine length u8, engine ASCII,
// semantic length u8, semantic ASCII, verified package hash[32];
// final CRC32 over all preceding bytes. Max 20 KiB.
inline std::vector<std::uint8_t> encodeBindingLedger(const SlotBindingLedger& ledger) {
    if(!validBindingLedger(ledger))throw std::invalid_argument("invalid slot semantic ledger");
    std::vector<SlotBindingIdentity> sorted=ledger.bindings;
    std::sort(sorted.begin(),sorted.end(),[](const auto& a,const auto& b){
        return a.hostSlot<b.hostSlot;
    });
    std::vector<std::uint8_t> out;
    out.reserve(16u+sorted.size()*300u);
    binding_detail::push32(out,0x49425746u); // "FWBI" LE
    binding_detail::push32(out,1u);
    binding_detail::push32(out,static_cast<std::uint32_t>(sorted.size()));
    for(const auto& b:sorted) {
        binding_detail::push32(out,b.hostSlot);
        binding_detail::push32(out,b.codecRevision);
        out.push_back(static_cast<std::uint8_t>(b.engineId.size()));
        out.insert(out.end(),b.engineId.begin(),b.engineId.end());
        out.push_back(static_cast<std::uint8_t>(b.semanticId.size()));
        out.insert(out.end(),b.semanticId.begin(),b.semanticId.end());
        out.insert(out.end(),b.packageSha256.begin(),b.packageSha256.end());
    }
    binding_detail::push32(out,binding_detail::crc32(out.data(),out.size()));
    return out;
}
inline bool decodeBindingLedger(const std::uint8_t* data,std::size_t size,
                                SlotBindingLedger& dest) {
    constexpr std::size_t maxBytes=16u+64u*(4u+4u+1u+128u+1u+128u+32u);
    if(!data||size<16||size>maxBytes)return false;
    std::size_t pos=0;
    std::uint32_t magic=0,version=0,count=0;
    if(!binding_detail::pop32(data,size,pos,magic)||magic!=0x49425746u ||
       !binding_detail::pop32(data,size,pos,version)||version!=1u||
       !binding_detail::pop32(data,size,pos,count)||count>64)return false;
    SlotBindingLedger pending;
    pending.bindings.reserve(count);
    for(std::uint32_t i=0;i<count;++i) {
        SlotBindingIdentity b;
        if(!binding_detail::pop32(data,size,pos,b.hostSlot)||
           !binding_detail::pop32(data,size,pos,b.codecRevision)||pos>=size)
            return false;
        const auto en=data[pos++];
        if(en==0||en>128||size-pos<en)return false;
        b.engineId.assign(reinterpret_cast<const char*>(data+pos),en);pos+=en;
        if(pos>=size)return false;
        const auto sn=data[pos++];
        if(sn==0||sn>128||size-pos<sn||size-pos-sn<36)return false;
        b.semanticId.assign(reinterpret_cast<const char*>(data+pos),sn);pos+=sn;
        if(size-pos<32)return false;
        for(std::size_t h=0;h<32;++h)b.packageSha256[h]=data[pos++];
        pending.bindings.push_back(std::move(b));
    }
    std::uint32_t crc=0;
    if(!binding_detail::pop32(data,size,pos,crc)||pos!=size||
       crc!=binding_detail::crc32(data,size-4)||
       !validBindingLedger(pending))return false;
    dest=std::move(pending);
    return true;
}
inline bool slotAuthorizedBySavedIdentity(const SlotBindingLedger& saved,
                                          const SlotBindingIdentity& verifiedActive) {
    if(!validBindingLedger(saved)||!binding_detail::legal(verifiedActive))return false;
    for(const auto& item:saved.bindings)
        if(item.hostSlot==verifiedActive.hostSlot)return item==verifiedActive;
    return false; // old projects without an identity are always inert
}
} // namespace fw
