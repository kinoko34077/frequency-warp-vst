#include "../../src/ui_manifest_approval.h"
#include <cstdio>
#include <stdexcept>
#include <string>
using namespace fw::ui_assets;
static void need(bool value,const char* reason){
    if(!value)throw std::runtime_error(reason);
}
static std::string hash(){
    return std::string(64,'a');
}
int main(){
    try {
        const std::string good=
            "FWUI-MANIFEST-V1\nindex.html\t6\t"+hash()+
            "\nhost-bridge.mjs\t9\t"+hash()+"\n";
        TrustedManifest trusted{};
        need(parseApprovedManifest(good,trusted),"valid manifest refused");
        need(trusted.version==1&&trusted.files.size()==2,
             "manifest fields not retained");
        need(trusted.files[0].sha256.front()==0xaa,
             "SHA256 text not decoded");
        const auto prior=trusted;
        need(!parseApprovedManifest("FWUI-MANIFEST-V2\n",trusted),
             "wrong version accepted");
        need(!parseApprovedManifest(good+"malformed-extra-entry\n",trusted),
             "malformed extra entry accepted");
        need(trusted.files.size()==prior.files.size(),
             "rejection replaced previous approved manifest");
        need(!parseApprovedManifest(
            "FWUI-MANIFEST-V1\nindex.html\t6\t"+hash()+"\n",trusted),
            "missing bridge accepted");
        need(!parseApprovedManifest(
            "FWUI-MANIFEST-V1\nindex.html\t6\t"+hash()+
            "\nindex.html\t6\t"+hash()+
            "\nhost-bridge.mjs\t9\t"+hash()+"\n",trusted),
            "duplicate asset accepted");
        need(!parseApprovedManifest(
            "FWUI-MANIFEST-V1\nindex.html\t6\t"+hash()+
            "\nhost-bridge.mjs\t01\t"+hash()+"\n",trusted),
            "noncanonical file length accepted");
        need(!parseApprovedManifest(
            "FWUI-MANIFEST-V1\nindex.html\t6\t"+hash()+
            "\nhost-bridge.mjs\t9\t"+std::string(64,'g')+"\n",trusted),
            "invalid digest accepted");
        need(!parseApprovedManifest(
            "FWUI-MANIFEST-V1\n../index.html\t6\t"+hash()+
            "\nhost-bridge.mjs\t9\t"+hash()+"\n",trusted),
            "invalid relative path accepted");
        std::puts("UI5B2B native-manifest approval parser PASS");
        return 0;
    }catch(const std::exception& e){
        std::fprintf(stderr,"UI5B2B manifest parser FAIL: %s\n",e.what());
        return 1;
    }
}
