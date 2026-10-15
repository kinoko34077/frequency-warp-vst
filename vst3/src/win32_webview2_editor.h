#pragma once
// UI-2 experimental WebView2 VST3 IPlugView. Issue #145.
// ONLY compiled when the pinned official Microsoft WebView2 SDK is supplied.
// Existing Win32EngineEditor remains the default and runtime-unavailable fallback.
// This first UI-2 implementation displays the unchanged local website; a later
// UI-3 unit will connect native WebMessageReceived to DAW parameter edits.
#if defined(_WIN32) && defined(FW_ENABLE_WEBVIEW2)
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#include <commctrl.h>
#include <WebView2.h>
#include <wrl.h>
#include <wrl/client.h>
#include <filesystem>
#include <cstring>
#include <array>
#include <sstream>
#include <locale>
#include <iomanip>
#include "web_ui_message.h"
#include <memory>
#include <functional>
#include <string>
#include "public.sdk/source/vst/vsteditcontroller.h"

namespace fw {
using Microsoft::WRL::ComPtr;
using Microsoft::WRL::Callback;
inline Steinberg::ViewRect kWebUiEditorRect{0,0,1100,760};

class Win32WebView2Editor final : public Steinberg::Vst::EditorView {
    struct Shared {
        HWND child=nullptr;
        bool alive=true;
        ComPtr<ICoreWebView2Controller> controller;
        ComPtr<ICoreWebView2> view;
        std::filesystem::path siteRoot;
        Steinberg::Vst::EditController* host=nullptr;
        // Invoked on GUI STA. Native Controller queries the Processor and
        // returns a recent worker+saved-FWS3 mask or zero, never JS claims.
        std::function<std::uint64_t()> verifiedGenericMask{};
        std::array<bool,128> editing{};
        bool uiReady=false;
    };
    std::shared_ptr<Shared> state_=std::make_shared<Shared>();
    bool ownsCom_=false;
    Steinberg::Vst::EditController* editController_=nullptr;

    static std::filesystem::path bundledUiRoot() {
        // Locate the installed VST3 binary, NOT the host DAW executable.
        HMODULE module=nullptr;
        if (!GetModuleHandleExW(
                GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS |
                GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
                reinterpret_cast<LPCWSTR>(&bundledUiRoot),&module)) return {};
        wchar_t path[32768]{};
        const DWORD used=GetModuleFileNameW(module,path,32768);
        if (!used || used>=32768) return {};
        const auto binary=std::filesystem::path(path);
        // Windows VST3 standard bundle: Contents/x86_64-win/plugin.vst3
        return binary.parent_path().parent_path() / L"Resources" / L"ui";
    }
    static void showError(const std::shared_ptr<Shared>& state,
                          const wchar_t* detail) noexcept {
        if (state && state->alive && IsWindow(state->child))
            SetWindowTextW(state->child,detail);
    }
    // Always run on the VST3 GUI/COM STA. Never touch audio callbacks here.
    static void sendSnapshot(Shared& state) {
        if(!state.alive||!state.uiReady||!state.view||!state.host)return;
        std::ostringstream json;
        json.imbue(std::locale::classic());
        json.precision(17);
        json<<R"({"protocol":"frequency-warp.host-ui.v1","kind":"snapshot","values":{)";
        bool first=true;
        const auto mask=state.verifiedGenericMask?
            state.verifiedGenericMask():std::uint64_t{0};
        auto append=[&](uint32_t id){
            if(state.editing[id])return; // never fight an in-progress drag
            const auto value=state.host->getParamNormalized(id);
            if(!std::isfinite(value)||value<0.||value>1.)return;
            if(!first)json<<",";
            first=false;
            json<<R"(")"<<id<<R"(":)"<<value;
        };
        for(uint32_t id=2;id<=5;id++)append(id);
        for(uint32_t id=64;id<=127;id++) {
            const auto enabled=(mask&(std::uint64_t{1}<<(id-64)))!=0;
            if(!enabled&&state.editing[id]) {
                state.host->endEdit(id);state.editing[id]=false;
            }
            if(enabled)append(id);
        }
        json<<"}}";
        const std::string ascii=json.str();
        const std::wstring message(ascii.begin(),ascii.end());
        state.view->PostWebMessageAsJson(message.c_str());
    }
    static void receive(Shared& state,std::wstring_view raw) {
        if(!state.alive||!state.host)return;
        const auto msg=parseUiWireMessage(raw);
        if(!msg)return;
        if(msg->kind==UiWireKind::Hello){
            state.uiReady=true;
            sendSnapshot(state);
            return;
        }
        // Generic DAW edits are native-masked against the latest verified,
        // same-project FWS3 and live worker permission, NEVER page metadata.
        const auto id=msg->id;
        const bool known=id>=2&&id<=5;
        const auto mask=state.verifiedGenericMask?
            state.verifiedGenericMask():std::uint64_t{0};
        const bool generic=id>=64&&id<=127 &&
             (mask&(std::uint64_t{1}<<(id-64)))!=0;
        if(!known&&!generic) {
            // A revoked ticket must terminate any in-progress gesture,
            // even if the browser subsequently sends no matching edit-end.
            if(id<128&&state.editing[id]) {
                state.host->endEdit(id);state.editing[id]=false;
            }
            return;
        }
        if(msg->kind==UiWireKind::Begin && !state.editing[id]){
            state.host->beginEdit(id);
            state.editing[id]=true;
        }else if(msg->kind==UiWireKind::Perform && state.editing[id]){
            if(state.host->setParamNormalized(id,msg->normalized)==Steinberg::kResultOk)
                state.host->performEdit(id,msg->normalized);
        }else if(msg->kind==UiWireKind::End && state.editing[id]){
            state.host->endEdit(id);
            state.editing[id]=false;
        }
    }
    static LRESULT CALLBACK browserWindowProc(HWND hwnd,UINT message,
                                               WPARAM w,LPARAM l,
                                               UINT_PTR,DWORD_PTR ref) {
        if(message==WM_TIMER && w==1){
            auto* state=reinterpret_cast<Shared*>(ref);
            if(state)sendSnapshot(*state);
            return 0;
        }
        return DefSubclassProc(hwnd,message,w,l);
    }
    static void createBrowser(const std::shared_ptr<Shared>& state) {
        std::weak_ptr<Shared> weak=state;
        const std::wstring profile=
            (std::filesystem::temp_directory_path() / L"FrequencyWarpVST3WebView2").wstring();
        const HRESULT hr=CreateCoreWebView2EnvironmentWithOptions(
            nullptr,profile.c_str(),nullptr,
            Callback<ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler>(
                [weak](HRESULT result,ICoreWebView2Environment* env)->HRESULT {
                    const auto live=weak.lock();
                    if(!live || !live->alive)return S_OK;
                    if(FAILED(result)||!env) {
                        showError(live,L"WebView2 environment failed. Restart without experimental UI.");return S_OK;
                    }
                    std::weak_ptr<Shared> sub=live;
                    const HRESULT started=env->CreateCoreWebView2Controller(live->child,
                        Callback<ICoreWebView2CreateCoreWebView2ControllerCompletedHandler>(
                            [sub](HRESULT status,ICoreWebView2Controller* ctrl)->HRESULT {
                                auto target=sub.lock();
                                if(!target || !target->alive)return S_OK;
                                if(FAILED(status)||!ctrl) {
                                    showError(target,L"WebView2 controller failed. Native file UI remains available.");return S_OK;
                                }
                                target->controller=ctrl;
                                if(FAILED(ctrl->get_CoreWebView2(&target->view))||!target->view) {
                                    showError(target,L"WebView2 browser creation failed.");return S_OK;
                                }
                                RECT bounds{};GetClientRect(target->child,&bounds);
                                ctrl->put_Bounds(bounds);
                                ComPtr<ICoreWebView2Settings> settings;
                                if(SUCCEEDED(target->view->get_Settings(&settings))&&settings) {
                                    settings->put_AreDefaultContextMenusEnabled(FALSE);
                                    settings->put_AreDevToolsEnabled(FALSE);
                                    settings->put_IsStatusBarEnabled(FALSE);
                                }
                                ComPtr<ICoreWebView2_3> virtualHost;
                                if(FAILED(target->view.As(&virtualHost))||!virtualHost||
                                   FAILED(virtualHost->SetVirtualHostNameToFolderMapping(
                                      L"fwvst.local",target->siteRoot.c_str(),
                                      COREWEBVIEW2_HOST_RESOURCE_ACCESS_KIND_DENY_CORS))) {
                                    showError(target,L"Local Web UI mapping unsupported.");return S_OK;
                                }
                                // Accept only trusted top-level local page messages.
                                // Slot and numeric validation additionally occur in
                                // parseUiWireMessage + receive(), not in JavaScript.
                                std::weak_ptr<Shared> messageTarget=target;
                                EventRegistrationToken msgToken{};
                                target->view->add_WebMessageReceived(
                                    Callback<ICoreWebView2WebMessageReceivedEventHandler>(
                                        [messageTarget](ICoreWebView2*,
                                           ICoreWebView2WebMessageReceivedEventArgs* args)->HRESULT {
                                            const auto owner=messageTarget.lock();
                                            if(!owner||!owner->alive||!args)return S_OK;
                                            LPWSTR source=nullptr;
                                            if(FAILED(args->get_Source(&source)))return S_OK;
                                            const std::wstring origin=source?source:L"";
                                            CoTaskMemFree(source);
                                            if(origin!=L"https://fwvst.local/index.html")return S_OK;
                                            LPWSTR payload=nullptr;
                                            if(FAILED(args->get_WebMessageAsJson(&payload)))return S_OK;
                                            if(payload){
                                                const std::wstring_view input(payload);
                                                if(input.size()<=512)receive(*owner,input);
                                                CoTaskMemFree(payload);
                                            }
                                            return S_OK;
                                        }).Get(),&msgToken);
                                // Refuse navigation to external origins in the embedded UI.
                                std::weak_ptr<Shared> nav=target;
                                EventRegistrationToken navToken{};
                                target->view->add_NavigationStarting(
                                    Callback<ICoreWebView2NavigationStartingEventHandler>(
                                        [nav](ICoreWebView2*,
                                              ICoreWebView2NavigationStartingEventArgs* args)->HRESULT {
                                            const auto liveNav=nav.lock();
                                            if(!liveNav||!liveNav->alive)return S_OK;
                                            LPWSTR uri=nullptr;
                                            if(SUCCEEDED(args->get_Uri(&uri))) {
                                                const std::wstring url=uri?uri:L"";
                                                CoTaskMemFree(uri);
                                                if(url.rfind(L"https://fwvst.local/",0)!=0)
                                                    args->put_Cancel(TRUE);
                                            }
                                            return S_OK;
                                        }).Get(),&navToken);
                                EventRegistrationToken loadToken{};
                                target->view->add_NavigationCompleted(
                                    Callback<ICoreWebView2NavigationCompletedEventHandler>(
                                        [nav](ICoreWebView2* browser,
                                              ICoreWebView2NavigationCompletedEventArgs* args)->HRESULT {
                                            const auto liveNav=nav.lock();
                                            if(!liveNav||!liveNav->alive)return S_OK;
                                            BOOL ok=FALSE;
                                            if(FAILED(args->get_IsSuccess(&ok))||!ok){
                                                showError(liveNav,L"Frequency Warp local website load failed.");
                                                return S_OK;
                                            }
                                            // Keep the web player in DOM for existing JS handlers,
                                            // but hide its file-preview panel inside the DAW.
                                            browser->ExecuteScript(
                                                LR"JS((()=>{
                                                  const style=document.createElement('style');
                                                  style.textContent='.player{display:none!important}';
                                                  document.head.appendChild(style);
                                                  const note=document.createElement('div');
                                                  note.textContent='VST3 embedded WebView2 prototype — DAW control binding pending';
                                                  note.style.cssText='padding:8px;background:#462f15;color:#fff;font:14px system-ui';
                                                  document.body.prepend(note);
                                                  import('./host-bridge.mjs').then(m=>{
                                                    window.__fwVstHostBridge=m.createHostUiBridge({
                                                      webview:window.chrome.webview,document
                                                    });
                                                  }).catch(()=>{});
                                                })())JS",nullptr);
                                            return S_OK;
                                        }).Get(),&loadToken);
                                target->view->Navigate(L"https://fwvst.local/index.html");
                                return S_OK;
                            }).Get());
                    if(FAILED(started)) showError(live,L"WebView2 controller setup failed.");
                    return S_OK;
                }).Get());
        if(FAILED(hr)) showError(state,L"WebView2 runtime unavailable. Disable experimental UI.");
    }
public:
    explicit Win32WebView2Editor(
        Steinberg::Vst::EditController* controller,
        std::function<std::uint64_t()> verifiedGenericMask={})
        :EditorView(controller,&kWebUiEditorRect),editController_(controller){
        state_->verifiedGenericMask=std::move(verifiedGenericMask);
    }
    static bool runtimeAvailable() noexcept {
        LPWSTR version=nullptr;
        const HRESULT hr=GetAvailableCoreWebView2BrowserVersionString(nullptr,&version);
        if(version)CoTaskMemFree(version);
        return SUCCEEDED(hr);
    }
    Steinberg::tresult PLUGIN_API isPlatformTypeSupported(Steinberg::FIDString type) override {
        return type && std::strcmp(type,Steinberg::kPlatformTypeHWND)==0
            ? Steinberg::kResultTrue:Steinberg::kResultFalse;
    }
    Steinberg::tresult PLUGIN_API attached(void* parent,Steinberg::FIDString type) override {
        if(!parent || isPlatformTypeSupported(type)!=Steinberg::kResultTrue)return Steinberg::kResultFalse;
        if(state_->child)return Steinberg::kResultFalse;
        state_->host=editController_;
        state_->siteRoot=bundledUiRoot();
        if(state_->siteRoot.empty()||
           !std::filesystem::is_regular_file(state_->siteRoot / L"index.html")||
           !std::filesystem::is_regular_file(state_->siteRoot / L"host-bridge.mjs"))
            return Steinberg::kResultFalse;
        const HRESULT com=CoInitializeEx(nullptr,COINIT_APARTMENTTHREADED);
        if(FAILED(com))return Steinberg::kResultFalse;
        ownsCom_=true;
        systemWindow=parent;
        state_->child=CreateWindowExW(0,L"STATIC",L"Initializing Frequency Warp WebView2...",
            WS_CHILD|WS_VISIBLE|WS_CLIPCHILDREN,0,0,1100,760,
            static_cast<HWND>(parent),nullptr,GetModuleHandleW(nullptr),nullptr);
        if(!state_->child){
            systemWindow=nullptr;CoUninitialize();ownsCom_=false;
            return Steinberg::kResultFalse;
        }
        if(!SetWindowSubclass(state_->child,browserWindowProc,
             reinterpret_cast<UINT_PTR>(this),
             reinterpret_cast<DWORD_PTR>(state_.get()))) {
            DestroyWindow(state_->child);state_->child=nullptr;systemWindow=nullptr;
            CoUninitialize();ownsCom_=false;return Steinberg::kResultFalse;
        }
        SetTimer(state_->child,1,250,nullptr);
        attachedToParent();
        createBrowser(state_);
        return Steinberg::kResultOk;
    }
    Steinberg::tresult PLUGIN_API removed() override {
        if(!state_->child)return Steinberg::kResultFalse;
        state_->alive=false;
        KillTimer(state_->child,1);
        RemoveWindowSubclass(state_->child,browserWindowProc,
            reinterpret_cast<UINT_PTR>(this));
        if(state_->host){
            for(uint32_t id=0;id<128;id++)
                if(state_->editing[id])state_->host->endEdit(id);
            state_->host=nullptr;
        }
        if(state_->controller)state_->controller->Close();
        state_->view.Reset();state_->controller.Reset();
        DestroyWindow(state_->child);
        state_->child=nullptr;
        systemWindow=nullptr;
        removedFromParent();
        if(ownsCom_){CoUninitialize();ownsCom_=false;}
        return Steinberg::kResultOk;
    }
    Steinberg::tresult PLUGIN_API onSize(Steinberg::ViewRect* rect) override {
        if(!rect)return Steinberg::kInvalidArgument;
        setRect(*rect);
        if(state_->child){
            SetWindowPos(state_->child,nullptr,0,0,rect->right-rect->left,
                rect->bottom-rect->top,SWP_NOZORDER|SWP_NOACTIVATE);
            if(state_->controller){
                RECT bounds{};GetClientRect(state_->child,&bounds);
                state_->controller->put_Bounds(bounds);
            }
        }
        return Steinberg::kResultOk;
    }
};
} // namespace fw
#endif
