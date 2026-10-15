#include "../../src/generic_descriptor_authorization_request.h"
#include <cstdint>
#include <iostream>
#include <stdexcept>
#include <vector>
static void need(bool ok,const char* why){if(!ok)throw std::runtime_error(why);}
int main(){
    try {
        fw::VerifiedProjectEngine current{};
        current.package={0x50,0x4b,0x03,0x04,0x2a,0x16};
        current.engineId="org.example.verified";
        current.sha256.fill(0x57);
        current.acceptedGeneration=5;
        current.active=true;
        fw::SlotBindingIdentity id{};
        id.hostSlot=64;id.codecRevision=1;
        id.engineId=current.engineId;id.semanticId="gain";
        id.packageSha256=current.sha256;
        fw::SlotBindingLedger ledger{{id}};
        auto state=fw::encodeBindingLedger(ledger);
        const std::vector<std::uint8_t> json={'{','}','\n'};
        fw::GenericDescriptorAuthorizationRequest result{};
        need(fw::buildGenericDescriptorAuthorizationRequest(
                current,state,json.data(),json.size(),result),
             "verified saved-FWS3 transport denied");
        need(result.project.package==current.package &&
             result.project.bindingLedger==state &&
             result.descriptor==json,"candidate altered exact bytes");
        auto stale=current;
        stale.sha256[0]^=1;
        auto preserved=result;
        need(!fw::buildGenericDescriptorAuthorizationRequest(
                 stale,state,json.data(),json.size(),result),
             "changed hash accepted");
        need(result.descriptor==preserved.descriptor &&
             result.project.package==preserved.project.package,
             "failed proof partially mutated output");
        stale=current;stale.package.push_back(0);
        need(!fw::buildGenericDescriptorAuthorizationRequest(
                 stale,state,json.data(),json.size(),result),
             "changed byte package accepted");
        stale=current;stale.active=false;
        need(!fw::buildGenericDescriptorAuthorizationRequest(
                 stale,state,json.data(),json.size(),result),
             "stopped worker accepted");
        stale=current;stale.acceptedGeneration=0;
        need(!fw::buildGenericDescriptorAuthorizationRequest(
                 stale,state,json.data(),json.size(),result),
             "unknown generation accepted");
        auto badLedger=state;badLedger.back()^=1;
        need(!fw::buildGenericDescriptorAuthorizationRequest(
                 current,badLedger,json.data(),json.size(),result),
             "bad ledger CRC accepted");
        need(!fw::buildGenericDescriptorAuthorizationRequest(
                 current,{},json.data(),json.size(),result),
             "old project lacking saved binding accepted");
        need(!fw::buildGenericDescriptorAuthorizationRequest(
                 current,state,nullptr,json.size(),result),
             "missing descriptor accepted");
        need(!fw::buildGenericDescriptorAuthorizationRequest(
                 current,state,json.data(),65537,result),
             "oversized descriptor accepted before buffer access");
        std::cout<<"PASS R3C2D0: exact FWS3 non-RT descriptor message proof, no implicit migration\n";
    }catch(const std::exception& e){
        std::cerr<<"FAIL R3C2D0: "<<e.what()<<'\n';return 1;
    }
}
