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
#include <algorithm>
#include <cstdint>
#include <filesystem>
#include <fstream>
#include <functional>
#include <string>
#include <utility>
#include <vector>
#include <cwchar>

namespace fw {
inline Steinberg::ViewRect kEngineEditorRect{0,0,560,210};
class Win32EngineEditor final:public Steinberg::Vst::EditorView {
public:
    using SendBytes=std::function<bool(const std::vector<uint8_t>&)>;
    Win32EngineEditor(Steinberg::Vst::EditController* controller,SendBytes sender)
        :EditorView(controller,&kEngineEditorRect),send_(std::move(sender)){}
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
        CreateWindowExW(0,L"STATIC",
            L"Drop a .fwengine file here, or use Browse (host drop support varies).",
            WS_CHILD|WS_VISIBLE|SS_LEFT,16,102,525,28,hwnd_,nullptr,
            GetModuleHandleW(nullptr),nullptr);
        status_=CreateWindowExW(0,L"STATIC",
            L"No engine selected. Audio remains latency-compensated Dry.",
            WS_CHILD|WS_VISIBLE|SS_LEFT,16,151,525,44,hwnd_,nullptr,
            GetModuleHandleW(nullptr),nullptr);
        DragAcceptFiles(hwnd_,TRUE);
        attachedToParent();
        return Steinberg::kResultOk;
    }
    Steinberg::tresult PLUGIN_API removed() override {
        if(!hwnd_)return Steinberg::kResultFalse;
        DragAcceptFiles(hwnd_,FALSE);
        RemoveWindowSubclass(hwnd_,SubclassProc,
                             reinterpret_cast<UINT_PTR>(this));
        DestroyWindow(hwnd_);
        hwnd_=status_=nullptr;
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
        }
        if(msg==WM_DROPFILES){
            const HDROP drop=reinterpret_cast<HDROP>(w);
            wchar_t path[32768]{};
            if(DragQueryFileW(drop,0,path,32768)>0)
                view->load(path);
            DragFinish(drop);
            return 0;
        }
        return DefSubclassProc(hwnd,msg,w,l);
    }
    void setStatus(const wchar_t* status) noexcept {
        if(status_)SetWindowTextW(status_,status);
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
        if(path_.empty()){setStatus(L"Nothing to reload. Select a .fwengine first.");return;}
        load(path_.c_str());
    }
    void load(const wchar_t* filename){
        if(!filename||!*filename)return;
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
        if(!send_||!send_(bytes)){
            setStatus(L"Could not queue engine (host inactive/busy or disconnected).");
            return;
        }
        // A sendMessage success is NOT module validation/activation.
        path_=path.wstring();
        setStatus(L"Queued for verification; not yet confirmed active.");
    }
    SendBytes send_;
    HWND hwnd_=nullptr,status_=nullptr;
    std::wstring path_;
};
} // namespace fw
#endif // _WIN32
