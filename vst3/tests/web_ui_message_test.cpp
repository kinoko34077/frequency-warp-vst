#include "../src/web_ui_message.h"
#include <cstdio>
#include <cstdlib>
#include <cmath>

static void require(bool ok,const char* msg){
    if(!ok){std::fprintf(stderr,"web-ui-message FAIL: %s\n",msg);std::abort();}
}
int main(){
    using namespace fw;
    const auto hello=parseUiWireMessage(
        LR"({"protocol":"frequency-warp.host-ui.v1","kind":"hello","version":1,"visibleBindings":[2,3,4,5]})");
    require(hello && hello->kind==UiWireKind::Hello,"versioned hello");
    const auto begin=parseUiWireMessage(
        LR"({"protocol":"frequency-warp.host-ui.v1","kind":"edit-begin","id":4})");
    require(begin && begin->kind==UiWireKind::Begin&&begin->id==4,"begin 4");
    const auto perform=parseUiWireMessage(
        LR"({"protocol":"frequency-warp.host-ui.v1","kind":"edit-perform","id":5,"value":0.123456789})");
    require(perform && perform->kind==UiWireKind::Perform&&perform->id==5 &&
            std::abs(perform->normalized-0.123456789)<1e-12,"perform normalized");
    const auto end=parseUiWireMessage(
        LR"({"protocol":"frequency-warp.host-ui.v1","kind":"edit-end","id":5})");
    require(end && end->kind==UiWireKind::End&&end->id==5,"end 5");
    const auto select=parseUiWireMessage(
        LR"({"protocol":"frequency-warp.host-ui.v1","kind":"binding-select"})");
    const auto confirm=parseUiWireMessage(
        LR"({"protocol":"frequency-warp.host-ui.v1","kind":"binding-confirm"})");
    require(select && select->kind==UiWireKind::SelectBinding,"native-only picker");
    require(confirm && confirm->kind==UiWireKind::ConfirmBinding,"explicit confirm");
    const auto chooseUi=parseUiWireMessage(
        LR"({"protocol":"frequency-warp.host-ui.v1","kind":"ui-select"})");
    const auto backUi=parseUiWireMessage(
        LR"({"protocol":"frequency-warp.host-ui.v1","kind":"ui-back"})");
    require(chooseUi&&chooseUi->kind==UiWireKind::UiSelect,"native-only UI picker");
    require(backUi&&backUi->kind==UiWireKind::UiBack,"native-only UI Back");
    for(auto bad:{
        LR"({"protocol":"frequency-warp.host-ui.v1","kind":"ui-select","path":"x"})",
        LR"({"protocol":"frequency-warp.host-ui.v1","kind":"ui-back","target":1})",
        LR"({"protocol":"frequency-warp.host-ui.v1","kind":"ui-activation-ready","generation":0,"version":1})",
        LR"({"protocol":"frequency-warp.host-ui.v1","kind":"ui-activation-ready","generation":1,"version":2})",
        LR"({"protocol":"frequency-warp.host-ui.v1","kind":"ui-activation-ready","generation":01,"version":1})",
        LR"({"protocol":"frequency-warp.host-ui.v1","kind":"binding-select","path":"C:/unsafe"})",
        LR"({"protocol":"frequency-warp.host-ui.v1","kind":"binding-confirm","ticket":1})",
        LR"({"protocol":"untrusted","kind":"edit-perform","id":5,"value":0.5})",
        LR"({"protocol":"frequency-warp.host-ui.v1","kind":"evil","id":4})",
        LR"({"protocol":"frequency-warp.host-ui.v1","kind":"edit-perform","id":128,"value":0.5})",
        LR"({"protocol":"frequency-warp.host-ui.v1","kind":"edit-perform","id":-1,"value":0.5})",
        LR"({"protocol":"frequency-warp.host-ui.v1","kind":"edit-perform","id":04,"value":0.5})",
        LR"({"protocol":"frequency-warp.host-ui.v1","kind":"edit-perform","id":4,"value":1.01})",
        LR"({"protocol":"frequency-warp.host-ui.v1","kind":"edit-perform","id":4,"value":-0.01})",
        LR"({"protocol":"frequency-warp.host-ui.v1","kind":"edit-perform","id":4,"value":null})",
        LR"({"protocol":"frequency-warp.host-ui.v1","kind":"edit-perform","id":4,"value":"0.5"})",
        LR"({"protocol":"frequency-warp.host-ui.v1","kind":"edit-begin","id":4,"value":0.3})",
        LR"({"protocol":"frequency-warp.host-ui.v1","kind":"edit-perform","id":4,"value":0.5,"extra":1})",
        LR"({"protocol":"frequency-warp.host-ui.v1","kind":"hello","version":2,"visibleBindings":[2,3,4,5]})"
    })require(!parseUiWireMessage(bad),"invalid command rejected");
    const auto generic=parseUiWireMessage(
        LR"({"protocol":"frequency-warp.host-ui.v1","kind":"edit-perform","id":64,"value":0.5})");
    require(generic && generic->id==64,"generic slot parsed; semantic authorization belongs to native caller");
    std::puts("UI/DAW v1 bounded message grammar PASS");
}
