#include "../../src/verified_generic_ledger_candidate.h"
#include <cstdint>
#include <iostream>
#include <stdexcept>
#include <string>

static void need(bool v,const char* s){if(!v)throw std::runtime_error(s);}
int main() {
    try {
        fw::VerifiedProjectEngine verified{};
        verified.active=true;
        verified.acceptedGeneration=7;
        verified.engineId="org.kinotch.gainhalf";
        verified.package={1,2,3};
        verified.sha256[0]=0x73;
        auto semantics=[](std::uint32_t slot,std::string& out) {
            if(slot==64){out="gain";return true;}
            if(slot==127){out="ratio";return true;}
            return false;
        };
        auto numeric=[](std::uint32_t slot,FWNativeGenericCodec& out) {
            out={slot,1,0,0,0.,4.,0.5};return true;
        };
        fw::SlotBindingLedger result{};
        result.bindings.push_back({64,1,"org.old.engine","old",verified.sha256});
        const auto initial=result;
        need(!fw::buildVerifiedGenericLedgerCandidate(
                verified,0,semantics,numeric,result),"zero mask denied");
        need(result.bindings==initial.bindings,"zero mask atomic");
        need(fw::buildVerifiedGenericLedgerCandidate(
                verified,1,semantics,numeric,result),"verified slot64 constructed");
        need(result.bindings.size()==1 && result.bindings[0].hostSlot==64 &&
             result.bindings[0].semanticId=="gain" &&
             result.bindings[0].engineId==verified.engineId &&
             result.bindings[0].packageSha256==verified.sha256,
             "candidate must use exact verified engine and WASM semantic");
        need(fw::validBindingLedger(result),"valid saved FWS3 binding record");
        const auto accepted=result;
        need(!fw::buildVerifiedGenericLedgerCandidate(
                verified,2,semantics,numeric,result),"undeclared slot denied");
        need(result.bindings==accepted.bindings,"failed candidate atomic");
        need(fw::buildVerifiedGenericLedgerCandidate(
                verified,(1ull<<63)|1ull,semantics,numeric,result),
                "top slot127 and bit0 accepted");
        need(result.bindings.size()==2 &&
             result.bindings[1].hostSlot==127,"64-bit highest slot supported");
        const auto success=result;
        verified.active=false;
        need(!fw::buildVerifiedGenericLedgerCandidate(
                verified,1,semantics,numeric,result),"inactive verified engine denied");
        verified.active=true;verified.acceptedGeneration=0;
        need(!fw::buildVerifiedGenericLedgerCandidate(
                verified,1,semantics,numeric,result),"stale zero generation denied");
        verified.acceptedGeneration=7;
        auto duplicate=[](std::uint32_t,std::string& out){out="gain";return true;};
        need(!fw::buildVerifiedGenericLedgerCandidate(
                verified,(1ull<<63)|1ull,duplicate,numeric,result),
                "same semantic reused across slots denied");
        auto forged=[](std::uint32_t,std::string& out){out="GARBAGE";return true;};
        need(!fw::buildVerifiedGenericLedgerCandidate(
                verified,1,forged,numeric,result),"invalid WASM semantic denied");
        auto mismatch=[](std::uint32_t slot,FWNativeGenericCodec& out) {
            out={slot+1,1,0,0,0.,4.,0.5};return true;
        };
        need(!fw::buildVerifiedGenericLedgerCandidate(
                verified,1,semantics,mismatch,result),"foreign slot codec denied");
        need(result.bindings==success.bindings,"no partial mutation on rejection");
        std::cout<<"R3C2D3 PASS: verified non-RT FWS3 ledger candidate, atomic denial\n";
    }catch(const std::exception& e){
        std::cerr<<"R3C2D3 FAIL: "<<e.what()<<'\n';return 1;
    }
}
