#include "../../src/project_binding_association.h"
#include <cstdio>
#include <cstdlib>
#include <vector>
static void check(bool ok,const char* what) {
    if(!ok){std::fprintf(stderr,"R2C3A binding association FAIL: %s\n",what);std::abort();}
}
static fw::SlotBindingIdentity item(unsigned slot,const char* semantic) {
    fw::SlotBindingIdentity b{};
    b.hostSlot=slot;b.codecRevision=1;
    b.engineId="org.kinotch.gainhalf";
    b.semanticId=semantic;
    b.packageSha256.fill(0x47);
    return b;
}
int main() {
    using namespace fw;
    EngineProjectState image{};
    image.values.fill(.5);
    image.package={0x50,0x4b,0x03,0x04,0x12,0x34}; // opaque test bytes
    SlotBindingLedger ledger{{item(64,"gain"),item(65,"mix")}};
    image.bindingLedger=encodeBindingLedger(ledger);
    const auto binary=encodeEngineProjectState(image);
    EngineProjectState decoded{};
    check(decodeEngineProjectState(binary.data(),binary.size(),decoded),
          "FWS3 portable project cannot restore ledger");
    VerifiedProjectEngine verified{};
    verified.package=image.package;
    verified.engineId="org.kinotch.gainhalf";
    verified.sha256.fill(0x47);
    verified.acceptedGeneration=11;
    verified.active=true;
    check(matchSavedBindingToVerifiedEngine(decoded,verified),
          "exact worker-confirmed association");
    verified.active=false;
    check(matchSavedBindingToVerifiedEngine(decoded,verified),
          "suspended but previously confirmed package can be preserved inert");
    verified.acceptedGeneration=0;
    check(!matchSavedBindingToVerifiedEngine(decoded,verified),
          "unverified matching bytes are not enough");
    verified.acceptedGeneration=11;
    verified.package.push_back(0);
    check(!matchSavedBindingToVerifiedEngine(decoded,verified),
          "different byte image even same claimed hash must fail");
    verified.package=image.package;
    verified.sha256[0]^=0xff;
    check(!matchSavedBindingToVerifiedEngine(decoded,verified),
          "different digest cannot hijack semantic ID");
    verified.sha256.fill(0x47);
    verified.engineId="org.example.unrelated";
    check(!matchSavedBindingToVerifiedEngine(decoded,verified),
          "different engine cannot hijack host slot");
    verified.engineId="org.kinotch.gainhalf";
    EngineProjectState old{};
    old.values=image.values;old.package=image.package;
    check(!matchSavedBindingToVerifiedEngine(old,verified),
          "legacy FWS2 must not authorize generic controls");
    auto changed=image;
    SlotBindingLedger different{{item(64,"gain"),item(65,"other")}};
    different.bindings[1].engineId="org.example.other";
    changed.bindingLedger=encodeBindingLedger(different);
    check(!matchSavedBindingToVerifiedEngine(changed,verified),
          "one different engine in ledger invalidates whole association");
    different.bindings[1].engineId="org.kinotch.gainhalf";
    different.bindings[1].packageSha256.fill(0x48);
    changed.bindingLedger=encodeBindingLedger(different);
    check(!matchSavedBindingToVerifiedEngine(changed,verified),
          "one different revision/hash invalidates whole association");
    changed=image;
    changed.bindingLedger.back()^=0x1;
    check(!matchSavedBindingToVerifiedEngine(changed,verified),
          "corrupted nested ledger denied");
    changed=image;
    changed.package.clear();
    check(!matchSavedBindingToVerifiedEngine(changed,verified),
          "no package cannot bind generic semantics");
    verified.package.clear();
    check(!matchSavedBindingToVerifiedEngine(image,verified),
          "worker without active verified package never binds");
    std::puts("PASS R2C3A: FWS3 exact worker association, no silent semantic alias, legacy inert");
}
