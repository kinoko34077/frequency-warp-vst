#include "../../src/generic_authorization_mailbox.h"
#include <array>
#include <cstdint>
#include <iostream>
#include <limits>
#include <stdexcept>
#include <thread>
#include <atomic>

static void require(bool result,const char* reason) {
    if(!result)throw std::runtime_error(reason);
}
int main() {
    using namespace fw;
    try {
        std::array<std::uint8_t,32> hash{};hash[0]=7;
        std::array<std::uint8_t,32> other{};other[0]=8;
        const GenericAuthorizationPlan plan{1ull,9,hash};
        auto codec=[](std::uint32_t slot,FWNativeGenericCodec& out) {
            out={slot,1,0,0,0.,4.,0.5};
            return true;
        };
        GenericAuthorizationSnapshot snapshot{};
        require(buildGenericAuthorizationSnapshot(plan,codec,snapshot),
                "valid WASM-owned numeric contract");
        require(snapshot.allowedMask==1 && snapshot.codec[0].max==4.,
                "copied slot64 WASM codec");
        GenericAuthorizationMailbox mailbox{};
        require(!mailbox.rtAllows(64,9,hash),"default denied");
        require(!mailbox.workerPublish(snapshot,9,other),"foreign hash denied");
        require(!mailbox.workerPublish(snapshot,10,hash),"stale generation denied");
        require(mailbox.workerPublish(snapshot,9,hash),"worker publish");
        require(!mailbox.rtAllows(64,9,hash),"no publication before RT adopt");
        mailbox.rtAdopt();
        require(mailbox.rtAllows(64,9,hash),"authorized slot64");
        require(!mailbox.rtAllows(65,9,hash),"unlisted slot denied");
        require(!mailbox.rtAllows(64,8,hash),"wrong epoch denied");
        require(!mailbox.rtAllows(64,9,other),"wrong package denied");
        require(mailbox.rtCodec(64,9,hash)->defaultValue==0.5,
                "canonical contract retained");
        mailbox.workerRevoke();
        require(!mailbox.rtAllows(64,9,hash),"immediate revoke before adopt");
        require(mailbox.workerPublish(snapshot,9,hash),"replacement publication");
        require(!mailbox.rtAllows(64,9,hash),"old ticket cannot reauthorize");
        mailbox.rtAdopt();
        require(mailbox.rtAllows(64,9,hash),"new ticket active");
        mailbox.workerRevoke();
        GenericAuthorizationSnapshot unchanged=snapshot;
        const GenericAuthorizationPlan invalidPlan{0,9,hash};
        require(!buildGenericAuthorizationSnapshot(invalidPlan,codec,unchanged),
                "missing mask denied");
        require(unchanged.allowedMask==1,"failure does not partially mutate");
        auto badCodec=[](std::uint32_t slot,FWNativeGenericCodec& out) {
            out={slot,1,0,0,0.,4.,std::numeric_limits<double>::quiet_NaN()};
            return true;
        };
        require(!buildGenericAuthorizationSnapshot(plan,badCodec,unchanged),
                "nonfinite WASM numeric data denied");
        auto mismatched=[](std::uint32_t,FWNativeGenericCodec& out) {
            out={65,1,0,0,0.,4.,0.5};return true;
        };
        require(!buildGenericAuthorizationSnapshot(plan,mismatched,unchanged),
                "wrong slot source rejected");
        auto rejected=[](std::uint32_t,FWNativeGenericCodec&) {return false;};
        require(!buildGenericAuthorizationSnapshot(plan,rejected,unchanged),
                "missing WASM codec rejected");
        GenericAuthorizationMailbox another{};
        require(!another.rtAllows(64,9,hash),"second instance isolated");
        require(another.workerPublish(snapshot,9,hash),"second publish");
        another.rtAdopt();
        require(another.rtAllows(64,9,hash),"second instance active");
        require(!mailbox.rtAllows(64,9,hash),"first remains revoked");
        another.resetStopped();
        require(!another.rtAllows(64,9,hash),"stop clears permission");
        // Fixed-depth overflow is an explicit rejection, never an old
        // ticket silently remaining active while RT stops consuming.
        GenericAuthorizationMailbox full{};
        for(unsigned i=0;i<4;i++)
            require(full.workerPublish(snapshot,9,hash),"fill bounded queue");
        require(!full.workerPublish(snapshot,9,hash),"overflow rejected");
        full.rtAdopt();
        require(!full.rtAllows(64,9,hash),"overflow remains fail closed");
        require(full.workerPublish(snapshot,9,hash),"recovery after drain");
        full.rtAdopt();
        require(full.rtAllows(64,9,hash),"recovery adopts new ticket");
        // No tearing under concurrent SPSC producer/consumer; the atomic
        // ticket fences already-copied packets after a revoke.
        GenericAuthorizationMailbox concurrent{};
        std::atomic<bool> done{false},failure{false};
        std::thread worker([&]{
            for(unsigned i=0;i<5000;i++) {
                concurrent.workerRevoke();
                concurrent.workerPublish(snapshot,9,hash);
            }
            concurrent.workerRevoke();
            done.store(true,std::memory_order_release);
        });
        while(!done.load(std::memory_order_acquire)) {
            concurrent.rtAdopt();
            if(concurrent.rtAllows(65,9,hash) ||
               concurrent.rtAllows(64,9,other))failure.store(true);
        }
        worker.join();
        concurrent.rtAdopt();
        require(!failure.load(),"multi-thread reject invariant");
        require(!concurrent.rtAllows(64,9,hash),"final revoke");
        std::cout<<"R3C2C1 PASS: immutable worker codec packet, RT gate, epoch/hash, revoke and SPSC\n";
    }catch(const std::exception& e){
        std::cerr<<"R3C2C1 FAIL: "<<e.what()<<'\n';return 1;
    }
}
