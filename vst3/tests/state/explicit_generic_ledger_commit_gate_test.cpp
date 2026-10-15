#include "../../src/explicit_generic_ledger_commit_gate.h"
#include <cstdint>
#include <iostream>
#include <stdexcept>
#include <vector>
static void need(bool ok,const char* message) {
    if(!ok)throw std::runtime_error(message);
}
int main(){
 try {
    fw::VerifiedProjectEngine current{};
    current.package={1,2,3};
    current.engineId="org.kinotch.gainhalf";
    current.sha256.fill(0x37);
    current.acceptedGeneration=7;
    current.active=true;
    fw::SlotBindingLedger bindings{};
    bindings.bindings.push_back({64,1,current.engineId,"gain",current.sha256});
    fw::GenericNewLedgerEvidence approval{};
    approval.requestId=42;
    approval.authorizedTicket=19;
    approval.acceptedGeneration=7;
    approval.packageSha256=current.sha256;
    approval.authorizedMask=1;
    approval.encodedLedger=fw::encodeBindingLedger(bindings);
    std::vector<std::uint8_t> result{0xEE};
    auto select=[&](const fw::GenericNewLedgerEvidence& e,
                    const fw::VerifiedProjectEngine& c,
                    std::uint64_t request,std::uint64_t ticket,
                    std::uint64_t mask,
                    const std::vector<std::uint8_t>& existing,
                    bool explicitIntent){
        return fw::selectExplicitNewLedgerForCommit(
            e,c,request,ticket,mask,existing,explicitIntent,result);
    };
    need(select(approval,current,42,19,1,{},true),"exact fresh proof accepted");
    need(result==approval.encodedLedger,"identity image mismatch");
    const auto accepted=result;
    need(!select(approval,current,42,19,1,{},false),"implicit create denied");
    need(!select(approval,current,42,19,1,accepted,true),"existing ledger migration denied");
    need(!select(approval,current,43,19,1,{},true),"mismatched request denied");
    need(!select(approval,current,42,20,1,{},true),"revoked ticket denied");
    need(!select(approval,current,42,19,2,{},true),"foreign mask denied");
    auto changed=current;changed.sha256[0]^=1;
    need(!select(approval,changed,42,19,1,{},true),"foreign package denied");
    changed=current;changed.acceptedGeneration=8;
    need(!select(approval,changed,42,19,1,{},true),"stale generation denied");
    changed=current;changed.active=false;
    need(!select(approval,changed,42,19,1,{},true),"inactive module denied");
    auto invalid=approval;
    invalid.encodedLedger.back()^=0xff;
    need(!select(invalid,current,42,19,1,{},true),"CRC malformed ledger denied");
    invalid=approval;invalid.authorizedMask=2;
    need(!select(invalid,current,42,19,2,{},true),"ledger/mask mismatch denied");
    invalid=approval;invalid.authorizedTicket=0;
    need(!select(invalid,current,42,0,1,{},true),"zero ticket denied");
    auto codec=bindings;codec.bindings[0].codecRevision=2;
    invalid=approval;invalid.encodedLedger=fw::encodeBindingLedger(codec);
    need(!select(invalid,current,42,19,1,{},true),"unroutable codec denied");
    need(result==accepted,"rejection may not mutate old saved ledger candidate");
    std::cout<<"R3C2D5 PASS: explicit FWS3 commit gate and revocation denial\n";
 }catch(const std::exception& e){
    std::cerr<<"R3C2D5 FAIL: "<<e.what()<<'\n';return 1;
 }
}
