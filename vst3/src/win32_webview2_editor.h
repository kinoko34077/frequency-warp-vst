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
#include <fstream>
#include <commdlg.h>
#include <vector>
#include <algorithm>
#include <cstring>
#include <array>
#include <sstream>
#include <locale>
#include <iomanip>
#include "web_ui_message.h"
#include "native_binding_flow.h"
#include "native_engine_abi.h"
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
        std::function<std::uint64_t(const std::vector<std::uint8_t>&)> prepareBinding{};
        std::function<bool(std::uint64_t)> commitBinding{};
        std::function<NewBindingStatus()> pollBinding{};
        NativeBindingFlow bindingFlow{};
        std::string displayedBindingPhase{};
        std::array<bool,128> editing{};
        bool uiReady=false;
        bool hasFocus=false;
        bool modalOpen=false;
        std::wstring preparedFile{};
        std::wstring preparedDigest{};
    };
    // Native file and confirmation dialogs pump host messages. Re-entrant
    // JS commands cannot initiate a second transaction during a modal loop.
    struct ModalGuard final {
        Shared& state;
        explicit ModalGuard(Shared& s):state(s){state.modalOpen=true;}
        ~ModalGuard(){state.modalOpen=false;}
        ModalGuard(const ModalGuard&)=delete;
        ModalGuard& operator=(const ModalGuard&)=delete;
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
    // Only the native Controller/Worker owns binding state and request IDs.
    static void sendBindingPhase(Shared& state,const char* phase) {
        if(!state.uiReady||!state.view||state.displayedBindingPhase==phase)return;
        state.displayedBindingPhase=phase;
        const std::string json=std::string(
            R"({"protocol":"frequency-warp.host-ui.v1","kind":"binding-state","phase":")")
            +phase+R"("})";
        const std::wstring wire(json.begin(),json.end());
        state.view->PostWebMessageAsJson(wire.c_str());
    }
    static void endAllEdits(Shared& state) {
        if(!state.host)return;
        for(std::uint32_t id=0;id<128;id++)if(state.editing[id]) {
            state.host->endEdit(id);state.editing[id]=false;
        }
    }
    static void pollBindingStatus(Shared& state,std::uint64_t currentMask) {
        if(state.pollBinding && state.bindingFlow.request())
            state.bindingFlow.observe(state.pollBinding());
        switch(state.bindingFlow.phase()) {
        case NativeBindingFlow::Phase::Idle: sendBindingPhase(state,"idle");break;
        case NativeBindingFlow::Phase::Preparing: sendBindingPhase(state,"preparing");break;
        case NativeBindingFlow::Phase::NeedsConfirmation: sendBindingPhase(state,"confirm");break;
        case NativeBindingFlow::Phase::Committing: sendBindingPhase(state,"committing");break;
        case NativeBindingFlow::Phase::Accepted:
            sendBindingPhase(state,currentMask!=0 ? "accepted":"inactive");
            break;
        case NativeBindingFlow::Phase::Rejected: sendBindingPhase(state,"rejected");break;
        }
    }
    // The OS picker, never the HTML, supplies descriptor file contents.
    static void selectBinding(Shared& state) {
        if(!state.prepareBinding||!state.child) {
            sendBindingPhase(state,"rejected");return;
        }
        const auto phase=state.bindingFlow.phase();
        if(phase==NativeBindingFlow::Phase::Preparing ||
           phase==NativeBindingFlow::Phase::NeedsConfirmation ||
           phase==NativeBindingFlow::Phase::Committing)return;
        std::vector<wchar_t> filename(32768,L'\0');
        OPENFILENAMEW dialog{};
        dialog.lStructSize=sizeof(dialog);dialog.hwndOwner=state.child;
        dialog.lpstrFile=filename.data();dialog.nMaxFile=static_cast<DWORD>(filename.size());
        dialog.lpstrFilter=L"Engine binding JSON (*.json)\0*.json\0\0";
        dialog.Flags=OFN_FILEMUSTEXIST|OFN_PATHMUSTEXIST|OFN_NOCHANGEDIR;
        bool selected=false;
        {
            ModalGuard modal(state);
            selected=GetOpenFileNameW(&dialog)!=FALSE;
        }
        // DAW may remove the editor while the native chooser pumps messages.
        if(!state.alive||!state.child||!IsWindow(state.child))return;
        if(!selected)return;
        const std::filesystem::path filePath{filename.data()};
        if(_wcsicmp(filePath.extension().c_str(),L".json")!=0) {
            sendBindingPhase(state,"rejected");return;
        }
        std::ifstream input(filePath,std::ios::binary|std::ios::ate);
        if(!input){sendBindingPhase(state,"rejected");return;}
        const auto size=input.tellg();
        if(size<=0||size>65536){sendBindingPhase(state,"rejected");return;}
        input.seekg(0);
        std::vector<std::uint8_t> bytes(static_cast<size_t>(size));
        if(!input.read(reinterpret_cast<char*>(bytes.data()),size) ||
           std::find(bytes.begin(),bytes.end(),0)!=bytes.end()) {
            sendBindingPhase(state,"rejected");return;
        }
        std::array<std::uint8_t,32> sha{};
        if(!fw_native_sha256_bytes(bytes.data(),bytes.size(),sha.data(),sha.size())) {
            sendBindingPhase(state,"rejected");return;
        }
        const auto request=state.prepareBinding(bytes);
        if(!state.bindingFlow.begin(request)) {
            sendBindingPhase(state,"rejected");return;
        }
        state.preparedFile=filePath.filename().wstring();
        std::wostringstream digestLabel;
        digestLabel<<std::hex<<std::setfill(L'0');
        // Short fingerprint for visual disambiguation only, not Worker authority.
        for(std::size_t i=0;i<8;i++)
            digestLabel<<std::setw(2)<<static_cast<unsigned>(sha[i]);
        state.preparedDigest=digestLabel.str();
        pollBindingStatus(state,0);
    }
    static void confirmBinding(Shared& state) {
        if(!state.commitBinding||!state.bindingFlow.canConfirm()||!state.child)return;
        const auto originalRequest=state.bindingFlow.request();
        const std::wstring label=L"File: "+state.preparedFile+
            L"\nSHA-256 prefix: "+state.preparedDigest+
            L"\nSave this Worker-verified binding to the DAW project?"+
            L"\nNo keeps the existing project unchanged.";
        int selected=IDNO;
        {
            ModalGuard modal(state);
            selected=MessageBoxW(state.child,label.c_str(),
                L"Confirm FWS3 Binding",MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2);
        }
        if(!state.alive||!state.child||!IsWindow(state.child)||
           selected!=IDYES||!state.bindingFlow.canConfirm()||
           state.bindingFlow.request()!=originalRequest)return;
        // Worker/Controller revalidate request, generation and current ticket.
        if(!state.commitBinding(originalRequest)) {
            state.bindingFlow.invalidate();
            sendBindingPhase(state,"rejected");return;
        }
        state.bindingFlow.confirmQueued();
        pollBindingStatus(state,0);
    }
    // Always run on the VST3 GUI/COM STA. Never touch audio callbacks here.
    static void sendSnapshot(Shared& state) {
        if(!state.alive||!state.uiReady||!state.view||!state.host)return;
        const auto mask=state.verifiedGenericMask?
            state.verifiedGenericMask():std::uint64_t{0};
        pollBindingStatus(state,mask);
        std::ostringstream json;
        json.imbue(std::locale::classic());
        json.precision(17);
        // The browser may render normalized generic sliders, but may never
        // decide eligibility from external descriptor JSON or a raw WASM bit.
        json<<R"({"protocol":"frequency-warp.host-ui.v1","kind":"snapshot","genericSlots":[)";
        bool firstSlot=true;
        for(uint32_t id=64;id<=127;id++) {
            if(!(mask&(std::uint64_t{1}<<(id-64))))continue;
            if(!firstSlot)json<<",";
            firstSlot=false;
            json<<id;
        }
        json<<R"(],"values":{)";
        bool first=true;
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
        if(!state.alive||!state.host||state.modalOpen)return;
        const auto msg=parseUiWireMessage(raw);
        if(!msg)return;
        if(msg->kind==UiWireKind::Hello){
            state.uiReady=true;
            state.displayedBindingPhase.clear();
            sendSnapshot(state);
            return;
        }
        if(msg->kind==UiWireKind::SelectBinding) {
            if(state.hasFocus)selectBinding(state);
            return;
        }
        if(msg->kind==UiWireKind::ConfirmBinding) {
            if(state.hasFocus)confirmBinding(state);
            return;
        }
        // Host mouse automation does not necessarily grant WebView keyboard
        // focus. Only OS-sensitive picker and confirmation need focus.
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
        if(message==WM_KILLFOCUS) {
            auto* state=reinterpret_cast<Shared*>(ref);
            if(state) {state->hasFocus=false;endAllEdits(*state);}
        }
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
                                EventRegistrationToken gotFocusToken{};
                                target->controller->add_GotFocus(
                                    Callback<ICoreWebView2FocusChangedEventHandler>(
                                        [messageTarget](ICoreWebView2Controller*,IUnknown*)->HRESULT {
                                            const auto owner=messageTarget.lock();
                                            if(owner && owner->alive)owner->hasFocus=true;
                                            return S_OK;
                                        }).Get(),&gotFocusToken);
                                // Browser focus loss may not reach the parent HWND.
                                EventRegistrationToken focusToken{};
                                target->controller->add_LostFocus(
                                    Callback<ICoreWebView2FocusChangedEventHandler>(
                                        [messageTarget](ICoreWebView2Controller*,IUnknown*)->HRESULT {
                                            const auto owner=messageTarget.lock();
                                            if(owner && owner->alive) {
                                                owner->hasFocus=false;
                                                endAllEdits(*owner);
                                            }
                                            return S_OK;
                                        }).Get(),&focusToken);
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
                                            endAllEdits(*liveNav);
                                            liveNav->uiReady=false;
                                            liveNav->hasFocus=false;
                                            liveNav->displayedBindingPhase.clear();
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
                                                  note.textContent='VST3 embedded WebView2 — generic controls appear only when native FWS3 authorization is active';
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
        std::function<std::uint64_t()> verifiedGenericMask={},
        std::function<std::uint64_t(const std::vector<std::uint8_t>&)> prepareBinding={},
        std::function<bool(std::uint64_t)> commitBinding={},
        std::function<NewBindingStatus()> pollBinding={})
        :EditorView(controller,&kWebUiEditorRect),editController_(controller){
        state_->verifiedGenericMask=std::move(verifiedGenericMask);
        state_->prepareBinding=std::move(prepareBinding);
        state_->commitBinding=std::move(commitBinding);
        state_->pollBinding=std::move(pollBinding);
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
        state_->bindingFlow.invalidate();
        state_->preparedFile.clear();state_->preparedDigest.clear();
        state_->prepareBinding={};state_->commitBinding={};
        state_->pollBinding={};state_->verifiedGenericMask={};
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
