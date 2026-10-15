#include "../../src/generic_ui_authorization.h"
#include <array>
#include <cstdint>
#include <iostream>
#include <stdexcept>
#include <vector>
static void check(bool pass,const char* why){if(!pass)throw std::runtime_error(why);}
int main(){
  try {
    fw::VerifiedProjectEngine w{};
    w.package={1,2,3,4};
    w.engineId="org.kinotch.gainhalf";
    w.acceptedGeneration=4;
    w.active=true;
    w.sha256[0]=0x53;
    fw::SlotBindingLedger ledger{};
    ledger.bindings.push_back({64,1,w.engineId,"gain",w.sha256});
    auto encoded=fw::encodeBindingLedger(ledger);
    const std::vector<std::uint8_t> json={'{','}',' '};
    fw::EngineProjectState out{};
    out.package={0xFE};
    check(fw::prepareSavedGenericUiAuthorization(w,encoded,json.data(),json.size(),1,out),
          "exact worker-authenticated FWS3 must stage");
    check(out.package==w.package && out.bindingLedger==encoded,"no UI package substitution");
    auto old=out;
    auto wrong=w;
    wrong.sha256[0]^=0x1;
    check(!fw::prepareSavedGenericUiAuthorization(wrong,encoded,json.data(),json.size(),2,out),
          "changed package hash must deny");
    check(out.package==old.package && out.bindingLedger==old.bindingLedger,
          "failed proof must preserve prior output");
    wrong=w;wrong.active=false;
    check(!fw::prepareSavedGenericUiAuthorization(wrong,encoded,json.data(),json.size(),3,out),
          "inactive engine must deny");
    wrong=w;wrong.acceptedGeneration=0;
    check(!fw::prepareSavedGenericUiAuthorization(wrong,encoded,json.data(),json.size(),4,out),
          "zero generation must deny");
    check(!fw::prepareSavedGenericUiAuthorization(w,{},json.data(),json.size(),5,out),
          "missing saved FWS3 ledger must deny");
    check(!fw::prepareSavedGenericUiAuthorization(w,encoded,json.data(),json.size(),0,out),
          "zero request must deny");
    check(!fw::prepareSavedGenericUiAuthorization(
        w,encoded,json.data(),json.size(),fw::kGenericUiMaxRequest+1,out),
        "host request overflow denied");
    check(!fw::prepareSavedGenericUiAuthorization(w,encoded,nullptr,1,10,out),
          "null descriptor denied");
    check(!fw::prepareSavedGenericUiAuthorization(w,encoded,json.data(),0,11,out),
          "empty descriptor denied");
    check(!fw::prepareSavedGenericUiAuthorization(w,encoded,json.data(),
          fw::kGenericUiDescriptorLimit+1,12,out),"oversized descriptor denied");
    const std::uint8_t nul[]={123,0,125};
    check(!fw::prepareSavedGenericUiAuthorization(w,encoded,nul,sizeof(nul),13,out),
          "binary NUL denied");
    check(out.package==old.package && out.bindingLedger==old.bindingLedger,
          "all invalid requests preserve image");
    std::cout<<"R3C2D0 PASS saved FWS3 identity and bounded descriptor transport guard\n";
  }catch(const std::exception& e){std::cerr<<"R3C2D0 FAIL "<<e.what()<<'\n';return 1;}
}
