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
// Worker-only; may inspect validated manifest, NEVER call from audio thread.
bool fw_native_supports_stream_controls(const FWNativeOpaque* handle);
// Non-RT immutable worker-verified package byte SHA256 + ASCII manifest
// engine ID. Returns engine ID length or 0 on invalid buffers. Caller must
// allocate exactly 32 hash bytes and up to 129 ASCII ID bytes including NUL.
// This is NOT proof of authorship/signature; activation still needs worker OK.
std::uint32_t fw_native_copy_verified_identity(
    const FWNativeOpaque* handle, std::uint8_t* sha_out,
    std::size_t sha_capacity, std::uint8_t* engine_out,
    std::size_t engine_capacity);
// Off-RT immutable module capability mask, bit positions are fixed ParamIDs.
std::uint64_t fw_native_stream_control_mask(const FWNativeOpaque* handle);
// Optional generic slot64..127 WASM capabilities, bit0=ParamID64.
// Off-RT only; identity/codec validation still required before host binding.
std::uint64_t fw_native_generic_slot_mask(const FWNativeOpaque* handle);
std::int32_t fw_native_process(
    FWNativeOpaque* handle, const float* input, float* output,
    std::uint32_t frames, const FWNativeEvent* events, std::uint32_t event_count);
}
static_assert(sizeof(FWNativeEvent)==16,"v1 event ABI layout changed");
static_assert(alignof(FWNativeEvent)==8,"v1 event ABI alignment changed");
