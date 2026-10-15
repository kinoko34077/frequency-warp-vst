#pragma once
// R2C3B: generic bounded native project stream reader. ReadFn must provide
// bool(void* destination, std::size_t bytes) with exact read semantics.
// No VST3 SDK dependency; no seek, paths, or RT calls. Handles legacy FWS1,
// FWS2 and optional FWS3 binding ledger images without unbounded allocation.
#include "engine_project_state.h"
#include <cstdint>
#include <vector>
namespace fw {
template<class ReadFn>
bool readProjectStateStream(ReadFn&& read,EngineProjectState& destination) {
    using S=EngineProjectState;
    try {
        std::vector<std::uint8_t> bytes(S::kLegacySize);
        if(!read(bytes.data(),bytes.size()))return false;
        if(state_detail::get32(bytes.data(),0)!=S::kMagic ||
           state_detail::get32(bytes.data(),8)!=S::kCount)return false;
        const std::uint32_t version=state_detail::get32(bytes.data(),4);
        if(version!=S::kV1 && version!=S::kV2 && version!=S::kV3)return false;
        if(version==S::kV1)
            return decodeEngineProjectState(bytes.data(),bytes.size(),destination);
        std::uint8_t lenBuf[4]{};
        if(!read(lenBuf,4))return false;
        const std::size_t packageLen=state_detail::get32(lenBuf,0);
        if(packageLen>S::kMaxPackage || (version==S::kV3&&packageLen==0))
            return false;
        bytes.insert(bytes.end(),lenBuf,lenBuf+4);
        const std::size_t offset=bytes.size();
        bytes.resize(offset+packageLen);
        if(packageLen>0&&!read(bytes.data()+offset,packageLen))return false;
        if(version==S::kV3) {
            if(!read(lenBuf,4))return false;
            const std::size_t ledgerLen=state_detail::get32(lenBuf,0);
            if(ledgerLen<16 || ledgerLen>S::kMaxLedger)return false;
            bytes.insert(bytes.end(),lenBuf,lenBuf+4);
            const std::size_t start=bytes.size();
            bytes.resize(start+ledgerLen);
            if(!read(bytes.data()+start,ledgerLen))return false;
        }
        std::uint8_t crc[4]{};
        if(!read(crc,4))return false;
        bytes.insert(bytes.end(),crc,crc+4);
        return decodeEngineProjectState(bytes.data(),bytes.size(),destination);
    } catch(...) {return false;}
}
} // namespace fw
