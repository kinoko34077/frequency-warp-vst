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
#include <WebView2.h>
#include <wrl.h>
#include <wrl/client.h>
#include <filesystem>
#include <memory>
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
    };
    std::shared_ptr<Shared> state_=std::make_shared<Shared>();
    bool ownsCom_=false;

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
    explicit Win32WebView2Editor(Steinberg::Vst::EditController* controller)
        :EditorView(controller,&kWebUiEditorRect){}
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
        attachedToParent();
        createBrowser(state_);
        return Steinberg::kResultOk;
    }
    Steinberg::tresult PLUGIN_API removed() override {
        if(!state_->child)return Steinberg::kResultFalse;
        state_->alive=false;
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
