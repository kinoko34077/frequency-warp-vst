// UI-5B3 W0: native WebView2 *runtime* prerequisite and blank/clear smoke.
// Separate from VST3 compiler/Steinberg Validator. No DAW and no network URLs.
// A PASS proves only: HWND STA controller, InPrivate Profile2, native blank
// NavigationStarting/NavigationCompleted IDs and ClearBrowsingDataAll callback.
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <unknwn.h>
#include <objidl.h>
#include <wrl.h>
#include <wrl/client.h>
#include <wrl/event.h>
#include <WebView2.h>
#include "../../src/ui_pinned_resource_router.h"
#include "../../src/ui_activation_transaction.h"
#include <filesystem>
#include <fstream>
#include <cstring>
#include <memory>
#include <iostream>
#include <chrono>
#include <string>
#include <string_view>
#include <exception>
#include <stdexcept>
#include <system_error>
#include <cstdint>

using Microsoft::WRL::Callback;
using Microsoft::WRL::ComPtr;

static constexpr wchar_t kPinnedUrl[]=L"https://fwvst.local/index.html";
static constexpr wchar_t kRejectedUrl[]=L"https://fwvst.local/missing.html";
static constexpr char kPinnedHtmlA[]="<html><body>PINNED_A</body></html>";
static constexpr char kPinnedHtmlB[]="<html><body>PINNED_B</body></html>";

struct Smoke {
    HWND hwnd=nullptr;
    bool finished=false;
    bool passed=false;
    std::string reason="uninitialized";
    std::uint64_t navigationId=0;
    bool awaitingBlank=false;
    bool awaitingPinned=false;
    unsigned pinnedRequests=0;
    unsigned clears=0;
    unsigned phase=0; // 0: A, 1: B, 2: Back A, 3: reject missing, 4: recover A
    unsigned deniedRequests=0;
    bool resourceReady=false;
    fw::ui_assets::UiActivationTransaction transaction{};
    std::shared_ptr<const fw::ui_assets::PinnedSnapshot> snapshotA;
    std::shared_ptr<const fw::ui_assets::PinnedSnapshot> snapshotB;
    std::filesystem::path uiRoot;
    ComPtr<ICoreWebView2Environment> env;
    ComPtr<ICoreWebView2Controller> controller;
    ComPtr<ICoreWebView2> view;
    ComPtr<ICoreWebView2Profile2> profile;

    void complete(bool success,const char* explanation) {
        if(finished)return;
        finished=true;
        passed=success;
        reason=explanation;
        std::cout<<(passed?"PASS: ":"FAIL: ")<<reason<<std::endl;
    }
};


// The same host alias is first mapped to a mutable folder and then unmapped.
// If the mapping still intercepts this request, the page will show
// UNAPPROVED_FOLDER or the explicit native router will never be invoked.
static bool startPinnedResourceRuntimeProbe(const std::shared_ptr<Smoke>& s) {
    if(!s->resourceReady) {
    ComPtr<ICoreWebView2_3> host;
    if(FAILED(s->view.As(&host))||!host){
        s->complete(false,"ICoreWebView2_3 virtual host API unavailable");
        return false;
    }
    const std::wstring uiFolder=s->uiRoot.wstring();
    if(FAILED(host->SetVirtualHostNameToFolderMapping(
        L"fwvst.local",uiFolder.c_str(),
        COREWEBVIEW2_HOST_RESOURCE_ACCESS_KIND_DENY_CORS))||
       FAILED(host->ClearVirtualHostNameToFolderMapping(L"fwvst.local"))){
        s->complete(false,"WebView2 virtual host mapping clear failed");
        return false;
    }
    if(FAILED(s->view->AddWebResourceRequestedFilter(
        L"*",COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL))){
        s->complete(false,"WebResourceRequested filter missing");
        return false;
    }
    EventRegistrationToken token{};
    std::weak_ptr<Smoke> weak=s;
    if(FAILED(s->view->add_WebResourceRequested(
        Callback<ICoreWebView2WebResourceRequestedEventHandler>(
            [weak](ICoreWebView2*,ICoreWebView2WebResourceRequestedEventArgs* args)->HRESULT {
                const auto owner=weak.lock();
                if(!owner||owner->finished||!args)return S_OK;
                ComPtr<ICoreWebView2WebResourceRequest> request;
                LPWSTR name=nullptr;
                if(FAILED(args->get_Request(&request))||!request||
                   FAILED(request->get_Uri(&name))){
                    owner->complete(false,"WebView2 resource request unavailable");
                    CoTaskMemFree(name);
                    return E_FAIL;
                }
                const std::wstring uri=name?name:L"";
                CoTaskMemFree(name);
                // Production UI-5B2B strict router, NOT a duplicated test
                // predicate: this exercises the actual approved snapshot
                // URL/extension/path/MIME allowlist used by the VST3 editor.
                const auto snap=owner->phase==1?owner->snapshotB:owner->snapshotA;
                // ASCII is ensured by the production parser; pass raw UTF-8
                // bytes here and let the real allowlist deny invalid paths.
                const auto routed=fw::ui_assets::findPinnedResource(
                    snap,std::string(uri.begin(),uri.end()));
                const bool pinned=routed.file!=nullptr;
                if(pinned)++owner->pinnedRequests;
                if(uri==kRejectedUrl)++owner->deniedRequests;
                ComPtr<IStream> stream;
                if(pinned) {
                    const auto bytes=routed.file->bytes.size();
                    HGLOBAL heap=GlobalAlloc(GMEM_MOVEABLE,bytes);
                    if(!heap){owner->complete(false,"response allocation failed");return E_OUTOFMEMORY;}
                    void* dest=GlobalLock(heap);
                    if(!dest){GlobalFree(heap);owner->complete(false,"response lock failed");return E_OUTOFMEMORY;}
                    std::memcpy(dest,routed.file->bytes.data(),bytes);
                    GlobalUnlock(heap);
                    if(FAILED(CreateStreamOnHGlobal(heap,TRUE,&stream))){
                        GlobalFree(heap);
                        owner->complete(false,"response stream failed");
                        return E_FAIL;
                    }
                }
                ComPtr<ICoreWebView2WebResourceResponse> response;
                const HRESULT hr=owner->env->CreateWebResourceResponse(
                    stream.Get(),pinned?200:403,pinned?L"OK":L"Denied",
                    pinned?L"Content-Type: text/html\r\nCache-Control: no-store":
                           L"Cache-Control: no-store",&response);
                if(FAILED(hr)||!response||FAILED(args->put_Response(response.Get()))){
                    owner->complete(false,"native WebView2 response installation failed");
                    return E_FAIL;
                }
                return S_OK;
            }).Get(),&token))){
        s->complete(false,"WebResourceRequested event registration failed");
        return false;
    }
    s->resourceReady=true;
    }
    s->awaitingPinned=true;
    s->navigationId=0;
    if(FAILED(s->view->Navigate(s->phase==3?kRejectedUrl:kPinnedUrl))){
        s->complete(false,"pinned URL navigation failed synchronously");
        return false;
    }
    return true;
}

int wmain() {
    const HRESULT apartment=CoInitializeEx(nullptr,COINIT_APARTMENTTHREADED);
    if(FAILED(apartment)) {
        std::cerr<<"FAIL: GUI STA unavailable"<<std::endl;
        return 2;
    }
    WNDCLASSEXW cls{};
    cls.cbSize=sizeof(cls);
    cls.lpfnWndProc=DefWindowProcW;
    cls.hInstance=GetModuleHandleW(nullptr);
    cls.lpszClassName=L"FWUI5B3WebView2Smoke";
    RegisterClassExW(&cls);
    const HWND window=CreateWindowExW(0,cls.lpszClassName,
        L"FWUI5B3 disposable smoke",WS_OVERLAPPEDWINDOW,
        CW_USEDEFAULT,CW_USEDEFAULT,640,420,nullptr,nullptr,
        cls.hInstance,nullptr);
    if(!window) {
        std::cerr<<"FAIL: temporary HWND unavailable"<<std::endl;
        CoUninitialize();
        return 2;
    }
    ShowWindow(window,SW_SHOW);
    const auto state=std::make_shared<Smoke>();
    state->hwnd=window;
    auto createSnapshot=[](const char* html) {
        auto mutableSnapshot=std::make_shared<fw::ui_assets::PinnedSnapshot>();
        mutableSnapshot->version=1;
        const auto count=std::strlen(html);
        mutableSnapshot->files.push_back({"index.html",
            std::vector<std::uint8_t>(html,html+count)});
        mutableSnapshot->files.push_back({"host-bridge.mjs",
            {'e','x','p','o','r','t',' ','{','}'}});
        return std::shared_ptr<const fw::ui_assets::PinnedSnapshot>(
            std::move(mutableSnapshot));
    };
    state->snapshotA=createSnapshot(kPinnedHtmlA);
    state->snapshotB=createSnapshot(kPinnedHtmlB);
    LPWSTR version=nullptr;
    const HRESULT available=GetAvailableCoreWebView2BrowserVersionString(nullptr,&version);
    if(FAILED(available)||!version||!*version) {
        state->complete(false,"WebView2 runtime absent; no browser behaviour tested");
    } else {
        std::wcout<<L"Runtime: "<<version<<std::endl;
    }
    CoTaskMemFree(version);

    std::filesystem::path profileRoot;
    if(!state->finished) {
        try {
            profileRoot=std::filesystem::temp_directory_path() /
                ("fwui5b3-smoke-"+std::to_string(GetCurrentProcessId())+
                 "-"+std::to_string(GetTickCount64()));
            std::filesystem::create_directories(profileRoot);
            state->uiRoot=profileRoot/"ui";
            std::filesystem::create_directories(state->uiRoot);
            std::ofstream mapping(state->uiRoot/"index.html",std::ios::binary);
            mapping<<"<html><body>UNAPPROVED_FOLDER</body></html>";
            if(!mapping)throw std::runtime_error("fixture creation failed");
        } catch(const std::exception& e) {
            state->complete(false,e.what());
        }
    }
    if(!state->finished) {
        const std::weak_ptr<Smoke> weak=state;
        const HRESULT requested=CreateCoreWebView2EnvironmentWithOptions(
            nullptr,profileRoot.c_str(),nullptr,
            Callback<ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler>(
                [weak](HRESULT hr,ICoreWebView2Environment* rawEnv)->HRESULT {
                    const auto s=weak.lock();
                    if(!s||s->finished)return S_OK;
                    if(FAILED(hr)||!rawEnv) {
                        s->complete(false,"WebView2 environment creation failed");
                        return S_OK;
                    }
                    s->env=rawEnv;
                    ComPtr<ICoreWebView2Environment10> modern;
                    ComPtr<ICoreWebView2ControllerOptions> options;
                    if(FAILED(s->env.As(&modern))||!modern||
                       FAILED(modern->CreateCoreWebView2ControllerOptions(&options))||
                       !options||
                       FAILED(options->put_IsInPrivateModeEnabled(TRUE))||
                       FAILED(options->put_ProfileName(L"FWUI5B3_PRIVATE_SMOKE"))) {
                        s->complete(false,"Environment10 InPrivate controller options unavailable");
                        return S_OK;
                    }
                    const HRESULT started=modern->CreateCoreWebView2ControllerWithOptions(
                        s->hwnd,options.Get(),
                        Callback<ICoreWebView2CreateCoreWebView2ControllerCompletedHandler>(
                            [weak](HRESULT status,ICoreWebView2Controller* rawController)->HRESULT {
                                const auto owner=weak.lock();
                                if(!owner||owner->finished)return S_OK;
                                if(FAILED(status)||!rawController) {
                                    owner->complete(false,"InPrivate controller creation failed");
                                    return S_OK;
                                }
                                owner->controller=rawController;
                                if(FAILED(owner->controller->get_CoreWebView2(&owner->view))||
                                   !owner->view){
                                    owner->complete(false,"CoreWebView2 unavailable");
                                    return S_OK;
                                }
                                ComPtr<ICoreWebView2_13> browser13;
                                ComPtr<ICoreWebView2Profile> rawProfile;
                                BOOL privateMode=FALSE;
                                if(FAILED(owner->view.As(&browser13))||!browser13||
                                   FAILED(browser13->get_Profile(&rawProfile))||!rawProfile||
                                   FAILED(rawProfile.As(&owner->profile))||!owner->profile||
                                   FAILED(rawProfile->get_IsInPrivateModeEnabled(&privateMode))||
                                   !privateMode){
                                    owner->complete(false,"Profile2 or verified InPrivate mode missing");
                                    return S_OK;
                                }
                                EventRegistrationToken starting{};
                                const HRESULT startHook=owner->view->add_NavigationStarting(
                                    Callback<ICoreWebView2NavigationStartingEventHandler>(
                                        [weak](ICoreWebView2*,
                                               ICoreWebView2NavigationStartingEventArgs* event)->HRESULT {
                                            auto active=weak.lock();
                                            if(!active||active->finished||!event)return S_OK;
                                            LPWSTR uri=nullptr;
                                            UINT64 id=0;
                                            BOOL initiated=FALSE;
                                            if(FAILED(event->get_Uri(&uri))||
                                               FAILED(event->get_NavigationId(&id))||
                                               FAILED(event->get_IsUserInitiated(&initiated))){
                                                CoTaskMemFree(uri);
                                                active->complete(false,"NavigationStarting data missing");
                                                return S_OK;
                                            }
                                            const bool expected=uri&&
                                                (active->awaitingBlank
                                                  ?std::wstring_view(uri)==L"about:blank"
                                                  :active->awaitingPinned&&std::wstring_view(uri)==
                                                      (active->phase==3?kRejectedUrl:kPinnedUrl));
                                            CoTaskMemFree(uri);
                                            if(!expected||!id||!initiated) {
                                                event->put_Cancel(TRUE);
                                                return S_OK;
                                            }
                                            if((active->awaitingBlank||active->awaitingPinned)&&!active->navigationId)
                                                active->navigationId=id;
                                            else if(active->navigationId!=id)
                                                event->put_Cancel(TRUE);
                                            return S_OK;
                                        }).Get(),&starting);
                                EventRegistrationToken completed{};
                                const HRESULT doneHook=owner->view->add_NavigationCompleted(
                                    Callback<ICoreWebView2NavigationCompletedEventHandler>(
                                        [weak](ICoreWebView2* browser,
                                               ICoreWebView2NavigationCompletedEventArgs* event)->HRESULT {
                                            const auto active=weak.lock();
                                            if(!active||active->finished||!event)return S_OK;
                                            UINT64 id=0;
                                            BOOL success=FALSE;
                                            if(FAILED(event->get_NavigationId(&id))||
                                               !id||id!=active->navigationId)return S_OK;
                                            if(active->awaitingPinned&&active->phase==3) {
                                                // A user-selected but unapproved/missing document
                                                // must get an actual HTTP 403, not directory/network
                                                // fallback. After the rejection, recover through
                                                // another native blank -> clear -> pinned A load.
                                                if(active->deniedRequests==0) {
                                                    active->complete(false,"unknown candidate did not hit native 403 router");
                                                    return S_OK;
                                                }
                                                std::cout<<"PASS candidate rejection: native HTTP 403"<<std::endl;
                                                active->phase=4;
                                                active->awaitingPinned=false;
                                                active->awaitingBlank=true;
                                                active->navigationId=0;
                                                active->pinnedRequests=0;
                                                if(FAILED(active->view->Navigate(L"about:blank")))
                                                    active->complete(false,"rejected candidate rollback blank failed");
                                                return S_OK;
                                            }
                                            LPWSTR source=nullptr;
                                            const bool ready=SUCCEEDED(event->get_IsSuccess(&success))&&
                                                success&&SUCCEEDED(browser->get_Source(&source))&&source&&
                                                std::wstring_view(source)==
                                                    (active->awaitingBlank?L"about:blank":kPinnedUrl);
                                            CoTaskMemFree(source);
                                            if(!ready) {
                                                active->complete(false,"native document navigation failed");
                                                return S_OK;
                                            }
                                            if(active->awaitingPinned) {
                                                if(!active->pinnedRequests){
                                                    active->complete(false,"pinned resource router was bypassed");
                                                    return S_OK;
                                                }
                                                active->awaitingPinned=false;
                                                const unsigned stage=active->phase;
                                                // Code executes INSIDE the live Chromium page:
                                                // verify exact per-version immutable bytes and
                                                // check old same-origin localStorage was erased
                                                // before B or Back was allowed to load.
                                                const wchar_t* script=stage==0
                                                    ?LR"JS((()=>{const ok=document.body.textContent.includes("PINNED_A");localStorage.setItem("fwui-version","A");return ok;})())JS"
                                                    :stage==1
                                                    ?LR"JS((()=>{const ok=document.body.textContent.includes("PINNED_B")&&localStorage.getItem("fwui-version")===null;localStorage.setItem("fwui-version","B");return ok;})())JS"
                                                    :LR"JS((()=>document.body.textContent.includes("PINNED_A")&&localStorage.getItem("fwui-version")===null)())JS";
                                                const HRESULT scriptCall=browser->ExecuteScript(
                                                    script,Callback<ICoreWebView2ExecuteScriptCompletedHandler>(
                                                        [weak,stage](HRESULT hr,LPCWSTR json)->HRESULT {
                                                            auto checked=weak.lock();
                                                            if(!checked||checked->finished)return S_OK;
                                                            if(checked->phase!=stage)return S_OK;
                                                            if(FAILED(hr)||!json||std::wstring_view(json)!=L"true"){
                                                                checked->complete(false,"version-specific live DOM / storage-isolation mismatch");
                                                                return S_OK;
                                                            }
                                                            std::cout<<"PASS stage "<<stage<<" live immutable DOM + storage through production pinned router"<<std::endl;
                                                            if(stage==4){
                                                                checked->complete(checked->clears==5&&
                                                                    checked->deniedRequests>=1,
                                                                    "real A-to-B-to-Back(A), reject unknown 403, recover A and five storage clears");
                                                                return S_OK;
                                                            }
                                                            ++checked->phase;
                                                            checked->awaitingBlank=true;
                                                            checked->navigationId=0;
                                                            checked->pinnedRequests=0;
                                                            if(FAILED(checked->view->Navigate(L"about:blank")))
                                                                checked->complete(false,"switch/back native blank failed");
                                                            return S_OK;
                                                        }).Get());
                                                if(FAILED(scriptCall))
                                                    active->complete(false,"live DOM script evaluation failed");
                                                return S_OK;
                                            }
                                            active->awaitingBlank=false;
                                            const HRESULT clear=active->profile->ClearBrowsingDataAll(
                                                Callback<ICoreWebView2ClearBrowsingDataCompletedHandler>(
                                                    [weak](HRESULT outcome)->HRESULT {
                                                        const auto target=weak.lock();
                                                        if(!target||target->finished)return S_OK;
                                                        if(FAILED(outcome)){
                                                            target->complete(false,"ClearBrowsingDataAll failed");
                                                            return S_OK;
                                                        }
                                                        ++target->clears;
                                                        startPinnedResourceRuntimeProbe(target);
                                                        return S_OK;
                                                    }).Get());
                                            if(FAILED(clear))active->complete(false,"storage clear call failed");
                                            return S_OK;
                                        }).Get(),&completed);
                                if(FAILED(startHook)||FAILED(doneHook)) {
                                    owner->complete(false,"WebView2 navigation event registration failed");
                                    return S_OK;
                                }
                                owner->awaitingBlank=true;
                                if(FAILED(owner->view->Navigate(L"about:blank")))
                                    owner->complete(false,"native blank navigation start failed");
                                return S_OK;
                            }).Get());
                    if(FAILED(started))s->complete(false,"controller API failed synchronously");
                    return S_OK;
                }).Get());
        if(FAILED(requested))state->complete(false,"WebView2 environment request failed synchronously");
    }

    const auto deadline=std::chrono::steady_clock::now()+std::chrono::seconds(40);
    while(!state->finished && std::chrono::steady_clock::now()<deadline) {
        const DWORD event=MsgWaitForMultipleObjectsEx(
            0,nullptr,250,QS_ALLINPUT,MWMO_INPUTAVAILABLE);
        if(event==WAIT_FAILED)break;
        MSG msg{};
        while(PeekMessageW(&msg,nullptr,0,0,PM_REMOVE)){
            if(msg.message==WM_QUIT)break;
            TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    }
    if(!state->finished)state->complete(false,"WebView2 STA runtime timed out");
    if(state->controller)state->controller->Close();
    state->view.Reset();
    state->controller.Reset();
    state->profile.Reset();
    state->env.Reset();
    DestroyWindow(window);
    CoUninitialize();
    // Profile storage is intentionally under a unique temporary directory;
    // Windows may still hold locks immediately after Close, so don't assert
    // deletion is proof of browser private mode (verified via profile API).
    std::error_code cleanupError;
    if(!profileRoot.empty())std::filesystem::remove_all(profileRoot,cleanupError);
    return state->passed?0:1;
}
