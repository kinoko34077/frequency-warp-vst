#pragma once
// Frequency Warp native WASM ABI v1 — S3b0, NON-REALTIME WORKER ONLY.
// Compatible with fwengine-runtime/src/ffi.rs (Rust repr(C), staticlib).
// Do NOT call prepare/process/release from IAudioProcessor::process(): the
// WASM interpreter and this ABI currently allocate, and may be blocking.
#include <stddef.h>
#include <stdint.h>
#ifdef __cplusplus
extern "C" {
#endif
typedef struct FWNativeEngine FWNativeEngine;
typedef struct FWNativeParamEvent {
    uint32_t id;
    uint32_t sample_offset;
    double canonical_value;
} FWNativeParamEvent;

// Return 1. Future incompatible ABI requires a different exported symbol.
uint32_t fw_native_abi_major_v1(void);
// Caller retains the input package buffer until this returns.
// Returns NULL on any rejected malformed/incompatible module.
FWNativeEngine* fw_native_prepare_v1(const uint8_t* fwengine_zip,
    size_t package_len,double sample_rate,uint32_t channels,uint32_t max_frames);
// Returns 0..4095; negative on error. Never invoke on audio callback.
int32_t fw_native_latency_v1(const FWNativeEngine* engine);
// This version ALLOCATES for each block. For diagnostics/offline worker ONLY.
// in/out use non-overlapping planar f32 samples, channels*frames elements.
// A zero-frame call with NULL in/out can flush offset-zero automation.
// Returns 0 on success, -1 invalid arguments, -2 runtime trap/status.
int32_t fw_native_process_nonrt_v1(FWNativeEngine* engine,
    const float* planar_in,float* planar_out,uint32_t frames,
    const FWNativeParamEvent* events,uint32_t event_count);
// Caller must ensure serial access and non-RT cleanup.
void fw_native_release_v1(FWNativeEngine* engine);
#ifdef __cplusplus
}
static_assert(sizeof(FWNativeParamEvent)==16,
    "Module ABI event must be (u32, u32, f64), 16 bytes");
#endif
