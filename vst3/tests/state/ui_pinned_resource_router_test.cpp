#include "../../src/ui_pinned_resource_router.h"
#include <cstdio>
#include <memory>
#include <stdexcept>
#include <string>
using namespace fw::ui_assets;
static void check(bool condition,const char* message){
    if(!condition)throw std::runtime_error(message);
}
int main(){
    try {
        auto state=std::make_shared<PinnedSnapshot>();
        state->version=1;
        state->files={
            PinnedFile{"index.html",{'<','h','1','>'}},
            PinnedFile{"host-bridge.mjs",{'e','x','p','o','r','t'}},
            PinnedFile{"style.css",{'a'}},
            PinnedFile{"dsp_core.wasm",{0,1,2,3}}
        };
        std::shared_ptr<const PinnedSnapshot> fixed=state;
        auto document=findPinnedResource(fixed,"https://fwvst.local/index.html");
        check(document.file && document.file->path=="index.html","missing local index");
        check(document.file->bytes.size()==4,"pinned bytes changed");
        check(std::string(document.mime)=="text/html; charset=utf-8","bad MIME");
        check(findPinnedResource(fixed,
            "https://fwvst.local/dsp_core.wasm").file!=nullptr,"missing pinned WASM");
        check(!findPinnedResource(fixed,
            "https://fwvst.local/unlisted.css").file,"unlisted resource served");
        check(!findPinnedResource(fixed,
            "https://fwvst.local/index.html?debug=true").file,"query was accepted");
        check(!findPinnedResource(fixed,
            "https://fwvst.local/%69ndex.html").file,"encoded alias was accepted");
        check(!findPinnedResource(fixed,
            "http://fwvst.local/index.html").file,"insecure origin accepted");
        check(!findPinnedResource(fixed,
            "https://fwvst.local/../index.html").file,"invalid path accepted");
        check(mimeForPinnedPath("source.exe")==nullptr,"unknown MIME accepted");
        std::string prior="unchanged";
        check(!pinnedRelativeFromUrl("https://fwvst.local/",prior) &&
              prior=="unchanged","invalid input mutated output");
        state->version=2;
        check(!findPinnedResource(fixed,
            "https://fwvst.local/index.html").file,"unsupported version accepted");
        std::puts("UI5B2B pinned-resource routing PASS");
        return 0;
    }catch(const std::exception& e){
        std::fprintf(stderr,"UI5B2B resource test failed: %s\n",e.what());
        return 1;
    }
}
