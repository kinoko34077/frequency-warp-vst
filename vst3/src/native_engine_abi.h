#pragma once
#include <cstddef>
#include <cstdint>
// C ABI shared by the Rust fwengine-runtime static library and future VST3 shell.
// Prepare and destroy are OFF audio thread; caller owns opaque handle lifetime.
// A handle must NEVER be destroyed until every callback using it finishes.
extern "C" {
struct FWNativeOpaque;
// Stable Rust runtime ABI handshake; call from non-RT plugin lifecycle.
std::uint32_t fw_native_abi_major();
struct FWNativeEvent {
    std::uint32_t id;
    std::uint32_t offset;
    double value;
};
FWNativeOpaque* fw_native_prepare(
    const std::uint8_t* zip, std::size_t bytes, double sample_rate,
    std::uint32_t channels, std::uint32_t max_frames);
void fw_native_destroy(FWNativeOpaque* handle);
std::uint32_t fw_native_latency(const FWNativeOpaque* handle);
bool fw_native_faulted(const FWNativeOpaque* handle);
std::int32_t fw_native_process(
    FWNativeOpaque* handle, const float* input, float* output,
    std::uint32_t frames, const FWNativeEvent* events, std::uint32_t event_count);
}
static_assert(sizeof(FWNativeEvent)==16,"v1 event ABI layout changed");
static_assert(alignof(FWNativeEvent)==8,"v1 event ABI alignment changed");
