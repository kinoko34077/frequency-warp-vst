#pragma once
// S3c-A minimal native Windows VST3 editor: file Browse / OS Drop / Reload.
// Actual status acknowledgement, verified Back and editable DSP control UI
// are separate S3c-B. Never claim accepted when the message is only queued.
#ifdef _WIN32
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#include <windowsx.h>
#include <commctrl.h>
#include <commdlg.h>
#include <shellapi.h>
#include "public.sdk/source/vst/vsteditcontroller.h"
#include "verified_engine_history.h"
#include "native_binding_flow.h"
#include <algorithm>
#include <cstdint>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <functional>
#include <string>
#include <utility>
#include <vector>
#include <cwchar>

namespace fw {
struct EngineStatusSnapshot {
    bool known=false;
    uint64_t completedId=0,accepted=0,handled=0;
    bool succeeded=false;
    uint32_t state=0;
};
inline Steinberg::ViewRect kEngineEditorRect{0,0,560,330};
class Win32EngineEditor final:public Steinberg::Vst::EditorView {
public:
    using SendBytes=std::function<uint64_t(const std::vector<uint8_t>&)>;
    using PollState=std::function<EngineStatusSnapshot()>;
    using PrepareBinding=std::function<uint64_t(const std::vector<uint8_t>&)>;
    using CommitBinding=std::function<bool(uint64_t)>;
    using PollBinding=std::function<NewBindingStatus()>;
    Win32EngineEditor(Steinberg::Vst::EditController* controller,
                      SendBytes sender,PollState poll,
                      PrepareBinding prepare={},CommitBinding commit={},
                      PollBinding bindingPoll={})
        :EditorView(controller,&kEngineEditorRect),send_(std::move(sender)),
         poll_(std::move(poll)),prepareBinding_(std::move(prepare)),
         commitBinding_(std::move(commit)),pollBinding_(std::move(bindingPoll)){}
    Steinberg::tresult PLUGIN_API isPlatformTypeSupported(
        Steinberg::FIDString type) override {
        return type&&std::strcmp(type,Steinberg::kPlatformTypeHWND)==0
             ? Steinberg::kResultTrue:Steinberg::kResultFalse;
    }
    Steinberg::tresult PLUGIN_API attached(void* parent,
                                          Steinberg::FIDString type) override {
        if(!parent||isPlatformTypeSupported(type)!=Steinberg::kResultTrue||
           hwnd_)return Steinberg::kResultFalse;
        systemWindow=parent;
        const auto& r=getRect();
        hwnd_=CreateWindowExW(0,L"STATIC",L"",
            WS_CHILD|WS_VISIBLE|WS_CLIPCHILDREN,
            0,0,r.right-r.left,r.bottom-r.top,
            static_cast<HWND>(parent),nullptr,GetModuleHandleW(nullptr),nullptr);
        if(!hwnd_){systemWindow=nullptr;return Steinberg::kResultFalse;}
        if(!SetWindowSubclass(hwnd_,SubclassProc,
                              reinterpret_cast<UINT_PTR>(this),
                              reinterpret_cast<DWORD_PTR>(this))){
            DestroyWindow(hwnd_);hwnd_=nullptr;systemWindow=nullptr;
            return Steinberg::kResultFalse;
        }
        CreateWindowExW(0,L"STATIC",L"Frequency Warp | DSP module (.fwengine)",
            WS_CHILD|WS_VISIBLE|SS_LEFT,16,12,520,24,hwnd_,nullptr,
            GetModuleHandleW(nullptr),nullptr);
        const auto button=[&](int id,const wchar_t* title,int x,int width){
            return CreateWindowExW(0,L"BUTTON",title,
                WS_CHILD|WS_VISIBLE|WS_TABSTOP|BS_PUSHBUTTON,x,54,width,30,
                hwnd_,reinterpret_cast<HMENU>(static_cast<INT_PTR>(id)),
                GetModuleHandleW(nullptr),nullptr);
        };
        button(101,L"Browse...",16,140);
        button(102,L"Reload",166,110);
        backButton_=button(103,L"Back (verified)",286,155);
        EnableWindow(backButton_,FALSE);
        CreateWindowExW(0,L"STATIC",
            L"Drop a .fwengine file here, or use Browse (host drop support varies).",
            WS_CHILD|WS_VISIBLE|SS_LEFT,16,102,525,28,hwnd_,nullptr,
            GetModuleHandleW(nullptr),nullptr);
        status_=CreateWindowExW(0,L"STATIC",
            L"Engine activation status not yet available. Browse to select.",
            WS_CHILD|WS_VISIBLE|SS_LEFT,16,151,525,44,hwnd_,nullptr,
            GetModuleHandleW(nullptr),nullptr);
        CreateWindowExW(0,L"STATIC",
            L"Optional new FWS3 engine binding (separate from DSP load)",
            WS_CHILD|WS_VISIBLE|SS_LEFT,16,202,525,22,hwnd_,nullptr,
            GetModuleHandleW(nullptr),nullptr);
        bindBrowse_=CreateWindowExW(0,L"BUTTON",L"Select binding JSON...",
            WS_CHILD|WS_VISIBLE|WS_TABSTOP|BS_PUSHBUTTON,
            16,230,215,30,hwnd_,reinterpret_cast<HMENU>(static_cast<INT_PTR>(104)),
            GetModuleHandleW(nullptr),nullptr);
        bindConfirm_=CreateWindowExW(0,L"BUTTON",L"Confirm Binding",
            WS_CHILD|WS_VISIBLE|WS_TABSTOP|BS_PUSHBUTTON,
            243,230,180,30,hwnd_,reinterpret_cast<HMENU>(static_cast<INT_PTR>(105)),
            GetModuleHandleW(nullptr),nullptr);
        if(bindConfirm_)EnableWindow(bindConfirm_,FALSE);
        bindStatus_=CreateWindowExW(0,L"STATIC",
            L"Binding optional. Loaded engine and original audio remain available.",
            WS_CHILD|WS_VISIBLE|SS_LEFT,16,277,525,36,hwnd_,nullptr,
            GetModuleHandleW(nullptr),nullptr);
        DragAcceptFiles(hwnd_,TRUE);
        SetTimer(hwnd_,1,250,nullptr);
        attachedToParent();
        return Steinberg::kResultOk;
    }
    Steinberg::tresult PLUGIN_API removed() override {
        if(!hwnd_)return Steinberg::kResultFalse;
        KillTimer(hwnd_,1);
        DragAcceptFiles(hwnd_,FALSE);
        RemoveWindowSubclass(hwnd_,SubclassProc,
                             reinterpret_cast<UINT_PTR>(this));
        DestroyWindow(hwnd_);
        hwnd_=status_=bindStatus_=bindBrowse_=bindConfirm_=nullptr;
        systemWindow=nullptr;
        removedFromParent();
        return Steinberg::kResultOk;
    }
    Steinberg::tresult PLUGIN_API onSize(Steinberg::ViewRect* newSize) override {
        if(!newSize)return Steinberg::kInvalidArgument;
        setRect(*newSize);
        if(hwnd_)SetWindowPos(hwnd_,nullptr,0,0,newSize->right-newSize->left,
            newSize->bottom-newSize->top,SWP_NOZORDER|SWP_NOACTIVATE);
        return Steinberg::kResultOk;
    }
private:
    static LRESULT CALLBACK SubclassProc(HWND hwnd,UINT msg,WPARAM w,LPARAM l,
        UINT_PTR,DWORD_PTR ref){
        auto* view=reinterpret_cast<Win32EngineEditor*>(ref);
        if(msg==WM_COMMAND&&HIWORD(w)==BN_CLICKED){
            if(LOWORD(w)==101){view->browse();return 0;}
            if(LOWORD(w)==102){view->reload();return 0;}
            if(LOWORD(w)==103){view->back();return 0;}
            if(LOWORD(w)==104){view->browseBinding();return 0;}
            if(LOWORD(w)==105){view->confirmBinding();return 0;}
        }
        if(msg==WM_TIMER && w==1){view->poll();return 0;}
        if(msg==WM_DROPFILES){
            const HDROP drop=reinterpret_cast<HDROP>(w);
            wchar_t path[32768]{};
            const UINT length=DragQueryFileW(drop,0,nullptr,0);
            if(length>0 && length<32768 &&
               DragQueryFileW(drop,0,path,32768)==length)
                view->load(path);
            else view->setStatus(L"Dropped filename exceeds supported path size.");
            DragFinish(drop);
            return 0;
        }
        return DefSubclassProc(hwnd,msg,w,l);
    }
    void setStatus(const wchar_t* status) noexcept {
        if(status_)SetWindowTextW(status_,status);
    }
    void setBindingStatus(const wchar_t* message) noexcept {
        if(bindStatus_)SetWindowTextW(bindStatus_,message);
    }
    void pollBinding() {
        if(!pollBinding_||bindingFlow_.phase()==NativeBindingFlow::Phase::Idle)
            return;
        const auto status=pollBinding_();
        if(!bindingFlow_.observe(status))return;
        switch(bindingFlow_.phase()) {
        case NativeBindingFlow::Phase::NeedsConfirmation:
            if(bindConfirm_)EnableWindow(bindConfirm_,TRUE);
            setBindingStatus(L"Worker verified JSON. Select Confirm Binding to save.");
            break;
        case NativeBindingFlow::Phase::Accepted:
            if(bindConfirm_)EnableWindow(bindConfirm_,FALSE);
            setBindingStatus(L"FWS3 saved; current worker authorized this binding.");
            break;
        case NativeBindingFlow::Phase::Rejected:
            if(bindConfirm_)EnableWindow(bindConfirm_,FALSE);
            setBindingStatus(L"Binding rejected; existing engine/audio retained.");
            break;
        default:break;
        }
    }
    void browseBinding() {
        if(!prepareBinding_) {
            setBindingStatus(L"Binding workflow unavailable; original audio unaffected.");
            return;
        }
        const auto phase=bindingFlow_.phase();
        if(phase==NativeBindingFlow::Phase::Preparing ||
           phase==NativeBindingFlow::Phase::NeedsConfirmation ||
           phase==NativeBindingFlow::Phase::Committing) {
            setBindingStatus(L"Resolve the pending binding request first.");
            return;
        }
        wchar_t filename[32768]{};
        OPENFILENAMEW dlg{};
        dlg.lStructSize=sizeof(dlg);dlg.hwndOwner=hwnd_;
        dlg.lpstrFile=filename;dlg.nMaxFile=32768;
        dlg.lpstrFilter=L"Engine binding JSON (*.json)\0*.json\0\0";
        dlg.Flags=OFN_FILEMUSTEXIST|OFN_PATHMUSTEXIST|OFN_NOCHANGEDIR;
        if(!GetOpenFileNameW(&dlg))return;
        const std::filesystem::path path{filename};
        if(_wcsicmp(path.extension().c_str(),L".json")!=0) {
            setBindingStatus(L"Choose a JSON binding descriptor.");
            return;
        }
        std::ifstream file(path,std::ios::binary|std::ios::ate);
        if(!file) {
            setBindingStatus(L"Binding JSON cannot be opened; engine unaffected.");
            return;
        }
        const auto size=file.tellg();
        if(size<=0||size>65536) {
            setBindingStatus(L"Binding JSON must contain 1..65536 bytes.");
            return;
        }
        file.seekg(0);
        std::vector<uint8_t> bytes(static_cast<size_t>(size));
        if(!file.read(reinterpret_cast<char*>(bytes.data()),size) ||
           std::find(bytes.begin(),bytes.end(),0)!=bytes.end()) {
            setBindingStatus(L"Unreadable or binary JSON; engine unaffected.");
            return;
        }
        const uint64_t request=prepareBinding_(bytes);
        if(!bindingFlow_.begin(request)) {
            setBindingStatus(L"Worker busy or disconnected; existing audio retained.");
            return;
        }
        if(bindConfirm_)EnableWindow(bindConfirm_,FALSE);
        setBindingStatus(L"JSON sent to worker for verification; NOT saved.");
    }
    void confirmBinding() {
        if(!bindingFlow_.canConfirm()||!commitBinding_)return;
        const auto request=bindingFlow_.request();
        if(!commitBinding_(request)) {
            bindingFlow_.invalidate();
            if(bindConfirm_)EnableWindow(bindConfirm_,FALSE);
            setBindingStatus(L"Commit request unavailable; reload JSON to retry.");
            return;
        }
        bindingFlow_.confirmQueued();
        if(bindConfirm_)EnableWindow(bindConfirm_,FALSE);
        setBindingStatus(L"Commit queued; checking worker state. Not yet confirmed.");
    }
    void browse(){
        wchar_t file[32768]{};
        OPENFILENAMEW dlg{};
        dlg.lStructSize=sizeof(dlg);dlg.hwndOwner=hwnd_;
        dlg.lpstrFile=file;dlg.nMaxFile=32768;
        dlg.lpstrFilter=L"Frequency Warp engine (*.fwengine)\0*.fwengine\0\0";
        dlg.Flags=OFN_FILEMUSTEXIST|OFN_PATHMUSTEXIST|OFN_NOCHANGEDIR;
        if(GetOpenFileNameW(&dlg))load(file);
    }
    void reload(){
        if(history_.current().path.empty()){
            setStatus(L"No confirmed file path to reload yet.");return;
        }
        load(history_.current().path.c_str());
    }
    void back() {
        if(history_.previous().bytes.empty()){
            setStatus(L"No previously verified engine available.");return;
        }
        submit(history_.previous().bytes,history_.previous().path);
    }
    void submit(const std::vector<uint8_t>& bytes,const std::wstring& path){
        if(history_.awaiting()){setStatus(L"Verification is still pending.");return;}
        if(bindingFlow_.phase()!=NativeBindingFlow::Phase::Idle) {
            bindingFlow_.invalidate();
            if(bindConfirm_)EnableWindow(bindConfirm_,FALSE);
            setBindingStatus(L"Engine changed; prior pending binding cannot be confirmed.");
        }
        const uint64_t request=send_?send_(bytes):0;
        if(request==0){
            setStatus(L"Could not queue engine (host inactive/busy/disconnected).");
            return;
        }
        if(!history_.begin(request,VerifiedPackage{bytes,path})){
            setStatus(L"Unable to track engine verification request.");return;
        }
        setStatus(L"Queued for verification; NOT yet confirmed active.");
    }
    void poll() {
        pollBinding();
        if(!poll_)return;
        const auto state=poll_();
        if(!state.known)return;
        if(state.state==0){
            if(bindingFlow_.phase()!=NativeBindingFlow::Phase::Idle) {
                bindingFlow_.invalidate();
                if(bindConfirm_)EnableWindow(bindConfirm_,FALSE);
                setBindingStatus(L"Worker stopped; any uncommitted JSON request cancelled.");
            }
            if(history_.awaiting())history_.cancel();
            setStatus(L"Host worker stopped. Select or reload engine when active.");
            return;
        }
        if(history_.awaiting() && state.completedId==history_.pendingId()){
            const auto outcome=history_.complete(state.completedId,state.succeeded);
            if(outcome==VerifiedEngineHistory::Outcome::Accepted){
                if(backButton_)EnableWindow(backButton_,
                    history_.previous().bytes.empty()?FALSE:TRUE);
                setStatus(state.state==4
                   ? L"Worker accepted engine. Active (verified)."
                   : L"Engine accepted but inactive/faulted; Dry fallback.");
            }else if(outcome==VerifiedEngineHistory::Outcome::Rejected){
                setStatus(L"Module rejected; last valid engine unchanged.");
            }
        }else if(!history_.awaiting()){
            if(state.state==6)
                setStatus(L"Engine faulted; latency-compensated Dry fallback.");
            else if(state.state==4 && state.accepted>0 &&
                    history_.current().bytes.empty())
                setStatus(L"Worker reports active engine (file identity unavailable).");
        }
    }
    void load(const wchar_t* filename){
        if(!filename||!*filename)return;
        if(history_.awaiting()){setStatus(L"Verification is still pending.");return;}
        std::filesystem::path path{filename};
        if(_wcsicmp(path.extension().c_str(),L".fwengine")!=0){
            setStatus(L"Only .fwengine packages are accepted.");return;
        }
        std::ifstream file(path,std::ios::binary|std::ios::ate);
        if(!file){setStatus(L"Cannot open file (check permissions).");return;}
        const auto size=file.tellg();
        if(size<=0||size>static_cast<std::streamoff>(8*1024*1024)){
            setStatus(L"Engine file is empty or exceeds 8 MiB.");return;
        }
        file.seekg(0);
        std::vector<uint8_t> bytes(static_cast<size_t>(size));
        if(!file.read(reinterpret_cast<char*>(bytes.data()),size)){
            setStatus(L"Failed to read complete engine file.");return;
        }
        submit(bytes,path.wstring());
    }
    SendBytes send_;
    PollState poll_;
    PrepareBinding prepareBinding_{};
    CommitBinding commitBinding_{};
    PollBinding pollBinding_{};
    NativeBindingFlow bindingFlow_{};
    HWND hwnd_=nullptr,status_=nullptr,backButton_=nullptr;
    HWND bindBrowse_=nullptr,bindConfirm_=nullptr,bindStatus_=nullptr;
    VerifiedEngineHistory history_{};
};
} // namespace fw
#endif // _WIN32
