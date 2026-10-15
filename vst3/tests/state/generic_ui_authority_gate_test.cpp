#include "../../src/generic_ui_authority_gate.h"
#include <iostream>
#include <stdexcept>
static void need(bool valid,const char* error){if(!valid)throw std::runtime_error(error);}
int main(){
    try {
        fw::VerifiedProjectEngine worker{};
        worker.active=true;worker.acceptedGeneration=1;
        worker.package={1,2,3};worker.engineId="org.test.gain";
        worker.sha256[0]=0x42;
        fw::SlotBindingLedger ledger{};
        ledger.bindings.push_back({64,1,worker.engineId,"gain",worker.sha256});
        fw::EngineProjectState project{};
        project.package=worker.package;
        project.bindingLedger=fw::encodeBindingLedger(ledger);
        need(fw::verifiedGenericUiMask(project,worker,32)==1,"verified FWS3 UI slot");
        need(fw::verifiedGenericUiMask(project,worker,0)==0,"revoked worker still permits GUI");
        auto changed=worker;changed.acceptedGeneration=0;
        need(fw::verifiedGenericUiMask(project,changed,32)==0,"inactive generation");
        changed=worker;changed.sha256[0]^=0x01;
        need(fw::verifiedGenericUiMask(project,changed,32)==0,"foreign package reuse");
        changed=worker;changed.active=false;
        need(fw::verifiedGenericUiMask(project,changed,32)==0,"inactive worker");
        project.bindingLedger.back()^=0xff;
        need(fw::verifiedGenericUiMask(project,worker,32)==0,"corrupt saved FWS3");
        std::cout<<"D8A PASS live worker ticket and saved FWS3 GUI mask gate\n";
    }catch(const std::exception& ex){std::cerr<<ex.what()<<'\n';return 1;}
}
