#include "../../src/rt_swap_mailbox.h"
#include <cmath>
#include <cstdlib>
#include <iostream>
static void check(bool v){if(!v)std::abort();}
struct Dummy {int id;};
int main(){
    Dummy a{1},b{2},c{3};
    fw::SwapMailbox<Dummy> q;
    check(q.publish(&a,480));
    check(!q.publish(&b,480)); // single pending writer slot
    q.beginBlock();
    check(q.active()==&a && q.outgoing()==nullptr && !q.switching());
    check(q.publish(&b,480));
    q.beginBlock();
    check(q.active()==&b&&q.outgoing()==&a&&q.switching());
    auto first=q.weightsAt(0),middle=q.weightsAt(240);
    check(first.outgoing==1.f&&first.incoming==0.f);
    check(std::abs(middle.incoming-.5f)<.00001f);
    check(!q.publish(&c,0)); // old engine cannot disappear mid-fade
    q.finishFrames(240);
    check(std::abs(q.weightsAt(0).incoming-.5f)<.00001f);
    q.finishFrames(240);
    check(q.active()==&b&&q.outgoing()==nullptr);
    check(!q.publish(&c,0)); // must retire old OUTSIDE audio thread
    check(q.takeRetired()==&a);
    check(q.takeRetired()==nullptr);
    check(q.publish(&c,0));
    q.beginBlock();
    check(q.active()==&c&&q.outgoing()==nullptr);
    check(q.takeRetired()==&b); // hard switch retires old, never deletes it
    q.reportActiveFault();
    check(q.active()==nullptr&&q.takeRetired()==&c); // delayed Dry fallback
    check(q.publish(&a,0));
    q.beginBlock();
    check(q.active()==&a);
    check(q.publish(&b,512));
    q.beginBlock();
    check(q.active()==&b&&q.outgoing()==&a);
    q.reportActiveFault(); // new engine fault during crossfade
    check(q.active()==&a&&q.outgoing()==nullptr);
    check(q.takeRetired()==&b);
    // Failure after another retirement is queued cannot overwrite pointer.
    check(q.publish(&c,0));q.beginBlock();
    check(q.takeRetired()==&a); // emulate retiring former active
    q.reportActiveFault();
    check(q.active()==nullptr&&q.takeRetired()==&c);
    check(q.publish(&a,0));q.beginBlock();
    auto stopped=q.drainStopped(); // only after audio callback quiesced
    check(stopped.active==&a&&stopped.outgoing==nullptr&&
        stopped.pending==nullptr&&stopped.retired==nullptr);
    check(q.active()==nullptr&&!q.busy());
    std::cout<<"PASS S3b2 pointer handoff/crossfade/fault rollback/off-RT retirement\n";
}
