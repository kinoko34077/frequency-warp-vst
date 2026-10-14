#pragma once
// S3b4-B: plugin-owned NON-AUDIO worker. Only this thread calls the Rust
// native Wasmi C ABI. All mailbox RT methods stay allocation-free.
// No file picker/DAW controller yet; UI will call postPackage() off RT.
#include "async_pcm_mailbox.h"
#include "native_engine_abi.h"
#include <atomic>
#include <chrono>
#include <cstdint>
#include <mutex>
#include <thread>
#include <utility>
#include <vector>

namespace fw {
class NativeWorkerService final {
public:
    enum class Status : uint32_t { Stopped, Starting, Missing, Preparing, Ready,
                                   Rejected, Faulted };
    NativeWorkerService()=default;
    NativeWorkerService(const NativeWorkerService&)=delete;
    NativeWorkerService& operator=(const NativeWorkerService&)=delete;
    ~NativeWorkerService(){stop();}
    // RT owns solely rtSubmit/rtReadWet; caller MUST stop DAW callback before
    // calling stop or destroying this object. Non-RT methods may allocate.
    AsyncPcmMailbox& mailbox() noexcept {return mailbox_;}
    Status status() const noexcept {return status_.load(std::memory_order_acquire);}
    uint64_t acceptedVersion() const noexcept {
        return accepted_.load(std::memory_order_acquire);
    }
    uint64_t handledRequests() const noexcept {
        return handled_.load(std::memory_order_acquire);
    }
    bool start() noexcept {
        if(thread_.joinable())return false;
        stopping_.store(false,std::memory_order_release);
        status_.store(Status::Starting,std::memory_order_release);
        try {
            thread_=std::thread([this]{run();});
        }catch(...) {
            status_.store(Status::Stopped,std::memory_order_release);
            return false;
        }
        return true;
    }
    // NonRT GUI/controller producer. It does not open arbitrary filesystem
    // paths; a bounded complete .fwengine package is the only input.
    bool postPackage(std::vector<uint8_t> bytes,double sampleRate,
                     uint32_t channels,uint32_t maxFrames=128) {
        if(!thread_.joinable()||bytes.empty()||bytes.size()>8*1024*1024||
           !(sampleRate>0.)||!(channels==1||channels==2)||
           maxFrames==0||maxFrames>128)return false;
        std::lock_guard<std::mutex> lock(commandMutex_);
        if(commandPending_||stopping_.load(std::memory_order_acquire))
            return false;
        pending_.bytes=std::move(bytes);
        pending_.rate=sampleRate;
        pending_.channels=channels;
        pending_.frames=maxFrames;
        commandPending_=true;
        return true;
    }
    // NonRT only. Host must quiesce audio process first.
    void stop() noexcept {
        stopping_.store(true,std::memory_order_release);
        if(thread_.joinable())thread_.join();
        {
            std::lock_guard<std::mutex> lock(commandMutex_);
            pending_=Request{};commandPending_=false;
        }
        // No worker or audio callback remains; all pending PCM is discarded.
        mailbox_.resetStopped();
        status_.store(Status::Stopped,std::memory_order_release);
    }
private:
    struct Request {
        std::vector<uint8_t> bytes;
        double rate=48000.;
        uint32_t channels=2,frames=128;
    };
    static int32_t processNative(void* context,const float* input,float* output,
                                 uint32_t frames,const FWNativeEvent* events,
                                 uint32_t count) noexcept {
        if(!context)return -1;
        return fw_native_process(static_cast<FWNativeOpaque*>(context),
                                 input,output,frames,events,count);
    }
    void run() noexcept {
        FWNativeOpaque* active=nullptr;
        status_.store(Status::Missing,std::memory_order_release);
        while(!stopping_.load(std::memory_order_acquire)) {
            Request req{};
            bool haveCommand=false;
            {
                // Locking is only on WORKER, never in RT mailbox API.
                std::lock_guard<std::mutex> lock(commandMutex_);
                if(commandPending_) {
                    req=std::move(pending_);
                    pending_=Request{};
                    commandPending_=false;
                    haveCommand=true;
                }
            }
            if(haveCommand) {
                status_.store(Status::Preparing,std::memory_order_release);
                FWNativeOpaque* candidate=fw_native_prepare(
                    req.bytes.data(),req.bytes.size(),req.rate,
                    req.channels,req.frames);
                const auto latency=candidate?fw_native_latency(candidate):UINT32_MAX;
                if(candidate&&latency<=AsyncPcmMailbox::kHostPdc&&
                    mailbox_.workerConfigure(processNative,candidate,latency)) {
                    auto* retired=std::exchange(active,candidate);
                    // Same worker thread cannot be inside workerStep and
                    // load/destroy at once; RT only holds copied PCM packets.
                    if(retired)fw_native_destroy(retired);
                    accepted_.fetch_add(1,std::memory_order_release);
                    status_.store(Status::Ready,std::memory_order_release);
                }else{
                    if(candidate)fw_native_destroy(candidate);
                    // Known-good active module remains configured if load fails.
                    status_.store(active?Status::Ready:Status::Rejected,
                                  std::memory_order_release);
                }
                handled_.fetch_add(1,std::memory_order_release);
            }
            bool work=false;
            // A fixed upper bound prevents endless worker-side drain loops
            // from starving later module selection or plugin teardown.
            for(unsigned i=0;i<8;i++) {
                if(!mailbox_.workerStep())break;
                work=true;
            }
            if(active&&fw_native_faulted(active)) {
                mailbox_.workerConfigure(nullptr,nullptr,0);
                fw_native_destroy(std::exchange(active,nullptr));
                status_.store(Status::Faulted,std::memory_order_release);
            }
            if(!work&&!haveCommand)
                std::this_thread::sleep_for(std::chrono::milliseconds(1));
        }
        // Worker quiescent: no C ABI call can overlap this destruction.
        mailbox_.workerConfigure(nullptr,nullptr,0);
        if(active)fw_native_destroy(active);
    }
    AsyncPcmMailbox mailbox_{};
    std::thread thread_{};
    std::mutex commandMutex_{};
    Request pending_{};
    bool commandPending_=false;
    std::atomic<bool> stopping_{true};
    std::atomic<Status> status_{Status::Stopped};
    std::atomic<uint64_t> accepted_{0};
    std::atomic<uint64_t> handled_{0};
};
} // namespace fw
