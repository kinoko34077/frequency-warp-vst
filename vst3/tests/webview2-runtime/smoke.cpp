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
#include <filesystem>
#include <memory>
#include <iostream>
#include <chrono>
#include <string>
#include <string_view>
#include <exception>
#include <system_error>
#include <cstdint>

using Microsoft::WRL::Callback;
using Microsoft::WRL::ComPtr;

struct Smoke {
    HWND hwnd=nullptr;
    bool finished=false;
    bool passed=false;
    std::string reason="uninitialized";
    std::uint64_t navigationId=0;
    bool awaitingBlank=false;
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
                                            const bool blank=uri&&std::wstring_view(uri)==L"about:blank";
                                            CoTaskMemFree(uri);
                                            if(!blank||!id||!initiated) {
                                                event->put_Cancel(TRUE);
                                                return S_OK;
                                            }
                                            if(active->awaitingBlank&&!active->navigationId)
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
                                            LPWSTR source=nullptr;
                                            const bool ready=SUCCEEDED(event->get_IsSuccess(&success))&&
                                                success&&SUCCEEDED(browser->get_Source(&source))&&
                                                source&&std::wstring_view(source)==L"about:blank";
                                            CoTaskMemFree(source);
                                            if(!ready) {
                                                active->complete(false,"native about:blank navigation failed");
                                                return S_OK;
                                            }
                                            active->awaitingBlank=false;
                                            const HRESULT clear=active->profile->ClearBrowsingDataAll(
                                                Callback<ICoreWebView2ClearBrowsingDataCompletedHandler>(
                                                    [weak](HRESULT outcome)->HRESULT {
                                                        const auto target=weak.lock();
                                                        if(target&&!target->finished)
                                                            target->complete(SUCCEEDED(outcome),
                                                                SUCCEEDED(outcome)
                                                                ?"InPrivate HWND + NavigationId + browser clear"
                                                                :"ClearBrowsingDataAll failed");
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
