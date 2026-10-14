#include "../src/verified_engine_history.h"
#include <cstdlib>
#include <iostream>
static void check(bool v){if(!v)std::abort();}
static fw::VerifiedPackage pkg(int marker){
    return {std::vector<uint8_t>{uint8_t(marker)},std::to_wstring(marker)};
}
int main(){
    using fw::VerifiedEngineHistory;
    using O=VerifiedEngineHistory::Outcome;
    VerifiedEngineHistory h;
    check(!h.begin(0,pkg(1)) && h.current().bytes.empty());
    check(h.begin(12,pkg(1)));
    check(h.awaiting() && h.pendingId()==12);
    check(!h.begin(13,pkg(2))); // one flight per plugin Controller
    check(h.complete(13,true)==O::Ignored);
    check(h.current().bytes.empty()); // no false promotion on stale ACK
    check(h.complete(12,true)==O::Accepted);
    check(h.current().bytes[0]==1&&h.previous().bytes.empty());
    check(h.begin(14,pkg(2)));
    check(h.complete(14,false)==O::Rejected);
    check(h.current().bytes[0]==1&&h.previous().bytes.empty());
    check(h.begin(15,pkg(3)));
    check(h.complete(15,true)==O::Accepted);
    check(h.current().bytes[0]==3&&h.previous().bytes[0]==1);
    // Back requires re-verification and then retains old current as Back target.
    check(h.begin(16,h.previous()));
    check(h.current().bytes[0]==3); // remains current until worker ACK
    check(h.complete(16,true)==O::Accepted);
    check(h.current().bytes[0]==1&&h.previous().bytes[0]==3);
    // Host deactivation cancels unresolved request without losing current.
    check(h.begin(17,pkg(4)));
    h.cancel();
    check(h.complete(17,true)==O::Ignored);
    check(h.current().bytes[0]==1&&h.previous().bytes[0]==3);
    check(!h.awaiting());
    std::cout<<"PASS verified engine package history: exact ACK, reject, Back, cancel\n";
}
