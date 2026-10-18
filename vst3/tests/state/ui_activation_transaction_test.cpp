#include "../../src/ui_activation_transaction.h"
#include <cstdio>
#include <memory>
#include <stdexcept>
using namespace fw::ui_assets;
static void need(bool b,const char* why){if(!b)throw std::runtime_error(why);}
static UiActivationTransaction::Snapshot fixture(std::uint32_t version=1){
    auto v=std::make_shared<PinnedSnapshot>();
    v->version=version;
    v->files.push_back(PinnedFile{"index.html",{1,2,3}});
    v->files.push_back(PinnedFile{"host-bridge.mjs",{4,5,6}});
    return v;
}
int main(){
    try {
        using Tx=UiActivationTransaction;
        Tx tx;
        auto a=fixture(),b=fixture(),c=fixture(),wrong=fixture(2);
        need(tx.phase()==Tx::Phase::Idle,"initial phase");
        need(!tx.prepare({})&&!tx.prepare(wrong),"untrusted candidate admitted");
        need(!tx.prepareBack(),"Back without last good");
        need(tx.prepare(a),"first candidate");
        need(tx.begin(false)==0,"non-user action started activation");
        need(tx.phase()==Tx::Phase::Prepared,"missing user intent changed phase");
        const auto ga=tx.begin(true);
        need(ga!=0&&tx.pendingGeneration()==ga,"first generation");
        need(!tx.prepare(b)&&!tx.prepareBack(),"reentrant prepare accepted");
        need(!tx.accept(ga+1,1,true,true),"wrong generation accepted");
        need(!tx.accept(ga,2,true,true),"wrong version accepted");
        need(!tx.accept(ga,1,false,true),"page-origin spoof accepted");
        need(!tx.accept(ga,1,true,false),"unverified handshake accepted");
        need(!tx.accept(0,1,true,true),"empty generation accepted");
        need(!tx.fail(ga+1),"wrong generation canceled target");
        need(tx.active()==nullptr,"candidate prematurely activated");
        need(tx.accept(ga,1,true,true),"verified first handshake refused");
        need(tx.active()==a&&tx.previous()==nullptr,"first activation wrong");
        need(!tx.accept(ga,1,true,true),"replayed ACK accepted");
        need(tx.prepare(b),"second candidate");
        const auto gb=tx.begin(true);
        need(gb>ga,"generation not increasing");
        need(tx.fail(gb),"valid failure refused");
        need(tx.active()==a&&tx.previous()==nullptr,"failure replaced last good");
        need(!tx.fail(gb)&&!tx.accept(gb,1,true,true),"late retry accepted");
        need(tx.prepare(b),"retry after failed candidate");
        const auto gc=tx.begin(true);
        need(gc>gb&&tx.accept(gc,1,true,true),"second UI activation");
        need(tx.active()==b&&tx.previous()==a,"last-good Back not saved");
        need(tx.prepare(c),"third candidate preparing");
        tx.editorDetached();
        need(tx.active()==b&&tx.previous()==a &&
             tx.phase()==Tx::Phase::Idle,"detach discarded last good");
        need(tx.prepareBack(),"Back unavailable");
        need(tx.pendingIntent()==Tx::Intent::Back,"wrong Back intent");
        const auto gd=tx.begin(true);
        need(gd>gc&&!tx.accept(gc,1,true,true),"stale ACK crossed Back");
        need(tx.fail(gd),"Back failure not cancellable");
        need(tx.active()==b&&tx.previous()==a,"failed Back lost current UI");
        need(tx.prepareBack(),"Back retry unavailable");
        const auto ge=tx.begin(true);
        need(ge>gd&&tx.accept(ge,1,true,true),"Back handshake failed");
        need(tx.active()==a&&tx.previous()==b,"Back switched wrong snapshot");
        need(tx.phase()==Tx::Phase::Idle,"Back left a pending request");
        need(!tx.accept(ge,1,true,true),"duplicate Back accept");
        need(tx.prepareBack(),"redo Back unavailable");
        tx.cancel();
        need(tx.phase()==Tx::Phase::Idle&&tx.active()==a,"cancel changed active");
        std::puts("UI5B2A explicit prepare / handshake / rollback PASS");
        return 0;
    }catch(const std::exception& err){
        std::fprintf(stderr,"UI5B2A FAIL: %s\n",err.what());return 1;
    }
}
