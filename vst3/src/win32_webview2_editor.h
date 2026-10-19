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
#include <bcrypt.h>
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
#include "ui_activation_transaction.h"
#include "ui_pinned_resource_router.h"
#include "ui_manifest_approval.h"
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
        HWND uiSelectButton=nullptr;
        HWND uiBackButton=nullptr;
        bool alive=true;
        ComPtr<ICoreWebView2Controller> controller;
        ComPtr<ICoreWebView2> view;
        ComPtr<ICoreWebView2Environment> environment;
        ui_assets::UiActivationTransaction uiActivation{};
        std::uint64_t activationStarted=0;
        std::uint64_t lastUiDialog=0;
        bool navigationLoaded=false;
        std::uint64_t servedIndexGeneration=0;
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
    // CNG is supplied by Windows and already linked through bcrypt.lib.
    // Only a short visual fingerprint is shown; Worker remains authoritative.
    static bool visualSha256(const std::vector<std::uint8_t>& data,
                             std::array<std::uint8_t,32>& sha) noexcept {
        BCRYPT_ALG_HANDLE algorithm=nullptr;
        BCRYPT_HASH_HANDLE hash=nullptr;
        bool ok=false;
        if(!BCRYPT_SUCCESS(BCryptOpenAlgorithmProvider(
            &algorithm,BCRYPT_SHA256_ALGORITHM,nullptr,0)))return false;
        ULONG objectSize=0,returned=0;
        if(BCRYPT_SUCCESS(BCryptGetProperty(algorithm,BCRYPT_OBJECT_LENGTH,
                reinterpret_cast<PUCHAR>(&objectSize),sizeof(objectSize),
                &returned,0)) && returned==sizeof(objectSize) &&
           objectSize>0 && objectSize<=65536) {
            std::vector<UCHAR> object(objectSize);
            if(BCRYPT_SUCCESS(BCryptCreateHash(algorithm,&hash,
                object.data(),objectSize,nullptr,0,0))) {
                if(BCRYPT_SUCCESS(BCryptHashData(hash,
                    const_cast<PUCHAR>(data.data()),
                    static_cast<ULONG>(data.size()),0)) &&
                   BCRYPT_SUCCESS(BCryptFinishHash(hash,sha.data(),
                                                  static_cast<ULONG>(sha.size()),0)))
                    ok=true;
            }
            if(hash)BCryptDestroyHash(hash);
        }
        BCryptCloseAlgorithmProvider(algorithm,0);
        return ok;
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
        if(!visualSha256(bytes,sha)) {
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
    static void rollbackUi(Shared& state) {
        const auto pending=state.uiActivation.pendingGeneration();
        if(!pending||!state.uiActivation.fail(pending))return;
        endAllEdits(state);state.uiReady=false;
        state.navigationLoaded=false;
        state.servedIndexGeneration=0;
        state.activationStarted=0;
        // Keep last-known-good approved snapshot. The bundled website remains
        // available as the initial legacy fallback if no snapshot was active.
        if(state.alive&&state.view)
            state.view->Navigate(L"https://fwvst.local/index.html");
    }
    static bool startUiNavigation(Shared& state) {
        const auto gen=state.uiActivation.begin(true);
        if(!gen||!state.view)return false;
        endAllEdits(state);state.uiReady=false;
        state.navigationLoaded=false;
        state.servedIndexGeneration=0;
        state.activationStarted=GetTickCount64();
        if(FAILED(state.view->Navigate(L"https://fwvst.local/index.html"))) {
            rollbackUi(state);return false;
        }
        return true;
    }
    static void selectApprovedUi(Shared& state) {
        if(state.modalOpen||!state.alive||!state.child||!state.view||
           state.uiActivation.phase()==ui_assets::UiActivationTransaction::Phase::AwaitingHandshake)
            return;
        const auto tick=GetTickCount64();
        if(tick-state.lastUiDialog<1000)return;
        state.lastUiDialog=tick;
        std::vector<wchar_t> name(32768,L'\0');
        OPENFILENAMEW dialog{};
        dialog.lStructSize=sizeof(dialog);dialog.hwndOwner=state.child;
        dialog.lpstrFile=name.data();dialog.nMaxFile=static_cast<DWORD>(name.size());
        dialog.lpstrFilter=L"Approved FWUI manifest (*.fwui)\0*.fwui\0\0";
        dialog.Flags=OFN_FILEMUSTEXIST|OFN_PATHMUSTEXIST|OFN_NOCHANGEDIR;
        bool chosen=false;
        {
            ModalGuard modal(state);
            chosen=GetOpenFileNameW(&dialog)!=FALSE;
        }
        if(!state.alive||!state.child||!IsWindow(state.child)||!chosen)return;
        const auto file=std::filesystem::path(name.data());
        if(file.extension()!=L".fwui"||
           file.native().rfind(L"\\\\",0)==0||
           ui_assets::hasUnsafeReparsePoint(file))return;
        std::ifstream input(file,std::ios::binary|std::ios::ate);
        if(!input)return;
        const auto size=input.tellg();
        if(size<=0||size>1024*1024)return;
        input.seekg(0);
        std::vector<std::uint8_t> bytes(static_cast<std::size_t>(size));
        if(!input.read(reinterpret_cast<char*>(bytes.data()),size))return;
        ui_assets::TrustedManifest manifest;
        if(!ui_assets::parseApprovedManifest(
            std::string_view(reinterpret_cast<const char*>(bytes.data()),
                             bytes.size()),manifest))return;
        std::shared_ptr<const ui_assets::PinnedSnapshot> snapshot;
        if(!ui_assets::stagePinnedCandidate(file.parent_path()/L"ui",
             manifest,fw_native_sha256_bytes,snapshot))return;
        std::array<std::uint8_t,32> hash{};
        if(!fw_native_sha256_bytes(bytes.data(),bytes.size(),
                                  hash.data(),hash.size()))return;
        std::wostringstream fingerprint;
        fingerprint<<std::hex<<std::setfill(L'0');
        for(std::size_t i=0;i<hash.size();i++)
            fingerprint<<std::setw(2)<<static_cast<unsigned>(hash[i]);
        std::uintmax_t totalBytes=0;
        for(const auto& item:manifest.files)totalBytes+=item.bytes;
        const std::wstring prompt=
            L"Activate this local UI?\nFolder: "+(file.parent_path()/L"ui").wstring()+
            L"\nManifest: "+file.wstring()+
            L"\nAssets: "+std::to_wstring(manifest.files.size())+
            L" files, "+std::to_wstring(totalBytes)+L" bytes"+
            L"\nManifest SHA-256: "+fingerprint.str()+
            L"\nUnsigned: hashes verify content, NOT the publisher."+
            L"\nNo retains the current UI.";
        int consent=IDNO;
        {
            ModalGuard modal(state);
            consent=MessageBoxW(state.child,prompt.c_str(),
                L"Confirm local UI activation",MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2);
        }
        if(!state.alive||!state.child||!IsWindow(state.child)||consent!=IDYES)return;
        if(!state.uiActivation.prepare(snapshot))return;
        if(!startUiNavigation(state))state.uiActivation.cancel();
    }
    static void selectPreviousUi(Shared& state) {
        if(!state.alive||!state.child||!state.view||state.modalOpen)return;
        if(state.uiActivation.phase()!=ui_assets::UiActivationTransaction::Phase::Idle||
           !state.uiActivation.previous())return;
        int consent=IDNO;
        {
            ModalGuard modal(state);
            consent=MessageBoxW(state.child,
                L"Restore the previous verified UI snapshot?\nAudio and DAW state remain unchanged.",
                L"Back to previous UI",MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2);
        }
        if(!state.alive||!state.child||!IsWindow(state.child)||consent!=IDYES)return;
        if(!state.uiActivation.prepareBack())return;
        if(!startUiNavigation(state))state.uiActivation.cancel();
    }
    static void receive(Shared& state,std::wstring_view raw) {
        if(!state.alive||!state.host||state.modalOpen)return;
        const auto msg=parseUiWireMessage(raw);
        if(!msg)return;
        if(msg->kind==UiWireKind::UiActivationReady){
            if(state.navigationLoaded &&
               state.servedIndexGeneration==msg->generation &&
               state.uiActivation.accept(msg->generation,1,true,true)) {
                state.activationStarted=0;
                state.uiReady=true;
                state.displayedBindingPhase.clear();
                sendSnapshot(state);
            }
            return;
        }
        // Until the current native-snapshot/bridge handshake is verified,
        // *no* DOM gesture, binding or hello can edit the DAW state.
        if(state.uiActivation.phase()==ui_assets::UiActivationTransaction::Phase::AwaitingHandshake)
            return;
        // Web content must NOT open native dialogs or switch UI.
        // The permanent Win32 toolbar below owns these actions.
        if(msg->kind==UiWireKind::UiSelect||
           msg->kind==UiWireKind::UiBack)return;
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
        if(message==WM_COMMAND) {
            auto* state=reinterpret_cast<Shared*>(ref);
            if(state && state->alive && HIWORD(w)==BN_CLICKED) {
                if(reinterpret_cast<HWND>(l)==state->uiSelectButton) {
                    selectApprovedUi(*state);return 0;
                }
                if(reinterpret_cast<HWND>(l)==state->uiBackButton) {
                    selectPreviousUi(*state);return 0;
                }
            }
        }
        if(message==WM_KILLFOCUS) {
            auto* state=reinterpret_cast<Shared*>(ref);
            if(state) {state->hasFocus=false;endAllEdits(*state);}
        }
        if(message==WM_APP+41){
            auto* state=reinterpret_cast<Shared*>(ref);
            if(state&&state->alive)rollbackUi(*state);
            return 0;
        }
        if(message==WM_TIMER && w==1){
            auto* state=reinterpret_cast<Shared*>(ref);
            if(state) {
                if(state->activationStarted &&
                   GetTickCount64()-state->activationStarted>8000)
                    rollbackUi(*state);
                sendSnapshot(*state);
            }
            return 0;
        }
        return DefSubclassProc(hwnd,message,w,l);
    }
    // Serve only immutable, digest-verified snapshot bytes when the native
    // activation transaction has a candidate or active image. A 404 / 403
    // response MUST be explicitly set; otherwise WebView2 falls through to
    // mutable virtual-host folder mapping or the network.
    // A resource handler that does not set Response falls through to the
    // actual network or mutable virtual-host mapping. Error handling itself
    // must set a non-success HTTP response; if the native environment cannot
    // construct one, terminate this WebView rather than continuing.
    static HRESULT failResourceClosed(
        Shared& state,ICoreWebView2WebResourceRequestedEventArgs* args) noexcept {
        if(state.environment && args) {
            ComPtr<ICoreWebView2WebResourceResponse> deny;
            if(SUCCEEDED(state.environment->CreateWebResourceResponse(
                nullptr,503,L"Unavailable",
                L"Cache-Control: no-store\r\nX-Content-Type-Options: nosniff",
                &deny))&&deny&&SUCCEEDED(args->put_Response(deny.Get()))) {
                if(state.uiActivation.pendingGeneration())
                    PostMessageW(state.child,WM_APP+41,0,0);
                return S_OK;
            }
        }
        state.uiReady=false;
        if(state.view)state.view->Stop();
        if(state.controller)state.controller->Close();
        state.view.Reset();state.controller.Reset();
        if(state.uiActivation.pendingGeneration())
            state.uiActivation.cancel();
        state.activationStarted=0;
        return E_ABORT;
    }
    static HRESULT pinnedResourceResponse(
        Shared& state,ICoreWebView2WebResourceRequestedEventArgs* args) noexcept {
        if(!args||!state.environment)return failResourceClosed(state,args);
        ComPtr<ICoreWebView2WebResourceRequest> request;
        if(FAILED(args->get_Request(&request))||!request)
            return failResourceClosed(state,args);
        LPWSTR raw=nullptr;
        if(FAILED(request->get_Uri(&raw)))
            return failResourceClosed(state,args);
        const std::wstring uri=raw?raw:L"";
        CoTaskMemFree(raw);
        std::string ascii;
        ascii.reserve(uri.size());
        bool isAscii=true;
        for(const wchar_t c:uri){
            if(c<0x21||c>0x7e){isAscii=false;break;}
            ascii.push_back(static_cast<char>(c));
        }
        const auto& tx=state.uiActivation;
        const auto pinned=tx.phase()==ui_assets::UiActivationTransaction::Phase::AwaitingHandshake
            ?tx.pending():tx.active();
        const bool local=isAscii && ascii.rfind("https://fwvst.local/",0)==0;
        if(!pinned&&local)return S_OK; // existing bundled offline mode only
        const auto found=local?ui_assets::findPinnedResource(pinned,ascii)
                              :ui_assets::RoutedResource{};
        const int status=found.file?200:(local?404:403);
        // A versioned JS hello never proves the new page came from pinned
        // bytes. Record that the native router actually served the index
        // from the exact pending immutable generation.
        COREWEBVIEW2_WEB_RESOURCE_CONTEXT context=
            COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL;
        const bool isTopLevelDocument=
            SUCCEEDED(args->get_ResourceContext(&context)) &&
            context==COREWEBVIEW2_WEB_RESOURCE_CONTEXT_DOCUMENT;
        if(found.file&&found.file->path=="index.html" &&
           isTopLevelDocument&&tx.pendingGeneration()!=0)
            state.servedIndexGeneration=tx.pendingGeneration();
        ComPtr<IStream> stream;
        if(found.file) {
            const auto& bytes=found.file->bytes;
            HGLOBAL owned=GlobalAlloc(GMEM_MOVEABLE,bytes.empty()?1:bytes.size());
            if(!owned)return failResourceClosed(state,args);
            void* address=GlobalLock(owned);
            if(!address){GlobalFree(owned);return failResourceClosed(state,args);}
            if(!bytes.empty())std::memcpy(address,bytes.data(),bytes.size());
            GlobalUnlock(owned);
            if(FAILED(CreateStreamOnHGlobal(owned,TRUE,&stream))){
                GlobalFree(owned);return failResourceClosed(state,args);
            }
        }
        std::wstring mimeHeaders=L"Cache-Control: no-store\r\nX-Content-Type-Options: nosniff";
        if(found.mime) {
            mimeHeaders=L"Content-Type: ";
            for(const char* p=found.mime;*p;p++)
                mimeHeaders.push_back(static_cast<wchar_t>(*p));
            mimeHeaders+=L"\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff";
        }
        ComPtr<ICoreWebView2WebResourceResponse> response;
        const auto ok=state.environment->CreateWebResourceResponse(
            stream.Get(),status,status==200?L"OK":L"Denied",
            mimeHeaders.c_str(),&response);
        if(FAILED(ok)||!response)return failResourceClosed(state,args);
        if(FAILED(args->put_Response(response.Get())))
            return failResourceClosed(state,args);
        return S_OK;
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
                            [sub,ownEnv=ComPtr<ICoreWebView2Environment>(env)](HRESULT status,ICoreWebView2Controller* ctrl)->HRESULT {
                                auto target=sub.lock();
                                if(!target || !target->alive)return S_OK;
                                if(FAILED(status)||!ctrl) {
                                    showError(target,L"WebView2 controller failed. Native file UI remains available.");return S_OK;
                                }
                                target->controller=ctrl;
                                target->environment=ownEnv;
                                if(FAILED(ctrl->get_CoreWebView2(&target->view))||!target->view) {
                                    showError(target,L"WebView2 browser creation failed.");return S_OK;
                                }
                                RECT bounds{};GetClientRect(target->child,&bounds);
                                bounds.top=44; // dedicated native UI recovery toolbar
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
                                // A user-selected UI is locally trusted only for its
                                // approved bytes, NOT for external browser/system effects.
                                EventRegistrationToken popupToken{};
                                if(FAILED(target->view->add_NewWindowRequested(
                                    Callback<ICoreWebView2NewWindowRequestedEventHandler>(
                                        [](ICoreWebView2*,
                                            ICoreWebView2NewWindowRequestedEventArgs* args)->HRESULT {
                                            if(args)args->put_Handled(TRUE);
                                            return S_OK;
                                        }).Get(),&popupToken))) {
                                    showError(target,L"Popup protection unavailable.");return S_OK;
                                }
                                EventRegistrationToken permissionsToken{};
                                if(FAILED(target->view->add_PermissionRequested(
                                    Callback<ICoreWebView2PermissionRequestedEventHandler>(
                                        [](ICoreWebView2*,
                                            ICoreWebView2PermissionRequestedEventArgs* args)->HRESULT {
                                            if(args)args->put_State(
                                                COREWEBVIEW2_PERMISSION_STATE_DENY);
                                            return S_OK;
                                        }).Get(),&permissionsToken))) {
                                    showError(target,L"Web permission protection unavailable.");return S_OK;
                                }
                                // Intercept *all* network/resource requests before navigation.
                                // No request may silently fall through after pinned activation.
                                if(FAILED(target->view->AddWebResourceRequestedFilter(
                                    L"*",COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL))) {
                                    showError(target,L"Resource interception unavailable.");return S_OK;
                                }
                                std::weak_ptr<Shared> resources=target;
                                EventRegistrationToken resourceToken{};
                                if(FAILED(target->view->add_WebResourceRequested(
                                    Callback<ICoreWebView2WebResourceRequestedEventHandler>(
                                        [resources](ICoreWebView2*,
                                            ICoreWebView2WebResourceRequestedEventArgs* args)->HRESULT {
                                            const auto current=resources.lock();
                                            if(!current||!current->alive)return E_ABORT;
                                            return pinnedResourceResponse(*current,args);
                                        }).Get(),&resourceToken))) {
                                    showError(target,L"Web resource interception failed.");return S_OK;
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
                                                if(liveNav->uiActivation.pendingGeneration())
                                                    rollbackUi(*liveNav);
                                                else showError(liveNav,L"Frequency Warp local website load failed.");
                                                return S_OK;
                                            }
                                            LPWSTR actualUri=nullptr;
                                            if(FAILED(browser->get_Source(&actualUri)))return S_OK;
                                            const std::wstring currentUri=actualUri?actualUri:L"";
                                            CoTaskMemFree(actualUri);
                                            if(currentUri!=L"https://fwvst.local/index.html") {
                                                if(liveNav->uiActivation.pendingGeneration())
                                                    rollbackUi(*liveNav);
                                                return S_OK;
                                            }
                                            liveNav->navigationLoaded=true;
                                            // Keep the web player in DOM for existing JS handlers,
                                            // but hide its file-preview panel inside the DAW.
                                            const auto pending=liveNav->uiActivation.pendingGeneration();
                                            const auto generation=pending &&
                                                liveNav->servedIndexGeneration==pending?pending:0;
                                            std::wstring injected=LR"JS((()=>{
                                                  const style=document.createElement('style');
                                                  style.textContent='.player{display:none!important}';
                                                  document.head.appendChild(style);
                                                  const note=document.createElement('div');
                                                  note.textContent='VST3 — generic edits need native verified binding';
                                                  note.style.cssText='padding:8px;background:#462f15;color:#fff;font:14px system-ui';
                                                  document.body.prepend(note);
                                                  import('./host-bridge.mjs').then(m=>{
                                                    window.__fwVstHostBridge=m.createHostUiBridge({
                                                      webview:window.chrome.webview,document
                                                    });
                                                    const generation=)JS";
                                            injected+=std::to_wstring(generation);
                                            injected+=LR"JS(;
                                                    if(generation>0)window.chrome.webview.postMessage({
                                                      protocol:'frequency-warp.host-ui.v1',
                                                      kind:'ui-activation-ready',generation,version:1
                                                    });
                                                  }).catch(()=>{});
                                                })())JS";
                                            browser->ExecuteScript(injected.c_str(),nullptr);
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
        state_->uiSelectButton=CreateWindowExW(0,L"BUTTON",L"Select verified UI...",
            WS_CHILD|WS_VISIBLE|BS_PUSHBUTTON,8,6,170,32,state_->child,
            reinterpret_cast<HMENU>(static_cast<INT_PTR>(1001)),
            GetModuleHandleW(nullptr),nullptr);
        state_->uiBackButton=CreateWindowExW(0,L"BUTTON",L"Back to previous UI",
            WS_CHILD|WS_VISIBLE|BS_PUSHBUTTON,186,6,175,32,state_->child,
            reinterpret_cast<HMENU>(static_cast<INT_PTR>(1002)),
            GetModuleHandleW(nullptr),nullptr);
        if(!state_->uiSelectButton||!state_->uiBackButton){
            if(state_->uiSelectButton)DestroyWindow(state_->uiSelectButton);
            if(state_->uiBackButton)DestroyWindow(state_->uiBackButton);
            RemoveWindowSubclass(state_->child,browserWindowProc,
                reinterpret_cast<UINT_PTR>(this));
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
        state_->uiActivation.editorDetached();
        state_->activationStarted=0;state_->navigationLoaded=false;
        state_->servedIndexGeneration=0;
        state_->view.Reset();state_->controller.Reset();state_->environment.Reset();
        DestroyWindow(state_->child);
        state_->uiSelectButton=nullptr;state_->uiBackButton=nullptr;
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
                bounds.top=44;
                state_->controller->put_Bounds(bounds);
            }
        }
        return Steinberg::kResultOk;
    }
};
} // namespace fw
#endif
