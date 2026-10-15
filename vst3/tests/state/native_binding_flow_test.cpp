#include "../../src/native_binding_flow.h"
#include <iostream>
#include <stdexcept>
static void need(bool ok,const char* why){if(!ok)throw std::runtime_error(why);}
int main(){
  try {
    fw::NativeBindingFlow f;
    using Phase=fw::NativeBindingFlow::Phase;
    need(!f.begin(0)&&!f.canConfirm(),"zero request rejected");
    need(f.begin(42)&&f.phase()==Phase::Preparing,"prepare queue");
    need(!f.begin(43)&&!f.confirmQueued(),"no concurrent prep/commit");
    need(!f.observe({41,0,true,false,false,false})&&
         f.phase()==Phase::Preparing,"old reply ignored");
    need(f.observe({42,0,true,false,false,false})&&f.canConfirm(),
         "same request proof allows explicit confirm");
    need(!f.observe({41,41,false,true,true,true})&&
         f.phase()==Phase::NeedsConfirmation,"unexpected commit ignored");
    need(f.confirmQueued()&&f.phase()==Phase::Committing,"commit requires click");
    need(!f.observe({42,42,true,true,false,false})&&
         f.phase()==Phase::Committing,"worker commit is not saved/active yet");
    need(f.observe({42,42,true,true,true,true})&&
         f.phase()==Phase::Accepted,"committed current FWS3 accepted");
    need(!f.confirmQueued(),"no duplicate commit");
    need(f.begin(44),"new action can restart after terminal state");
    need(f.observe({44,0,false,false,false,false})&&
         f.phase()==Phase::Rejected,"bad descriptor rejects only binding");
    need(f.begin(45),"recoverable binding rejection allows retry");
    f.invalidate();
    need(!f.observe({45,45,true,true,true,true})&&
         f.phase()==Phase::Idle,"worker stop/reload cancels stale replies");
    std::cout<<"D8C PASS native explicit binding workflow and stale reply guards\n";
  } catch(const std::exception& e) {
    std::cerr<<"D8C FAIL "<<e.what()<<'\n';return 1;
  }
}
