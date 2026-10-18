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
// Additive non-RT UI asset digest. True writes exactly 32 bytes; false
// preserves output. Bounded to 8 MiB input, matching UI asset policy.
// Digest identity is not proof of signer/publisher authenticity.
bool fw_native_sha256_bytes(const std::uint8_t* data,std::size_t bytes,
                            std::uint8_t* digest,std::size_t capacity);
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
// Read-only non-RT canonical value check against WASM-authored range/granularity;
// this is NOT DAW automation authorization (R3C2 is required).
bool fw_native_generic_value_in_contract(
    const FWNativeOpaque* handle,std::uint32_t host_slot,double canonical_value);
// Read-only WASM-owned canonical numeric descriptor (not external HTML
// metadata). ABI v1 additive; only call on live verified native worker,
// non-RT. Caller still must match project FWS3 semantic identity and
// generation before enabling DAW edits or audio parameter routing.
struct FWNativeGenericCodec {
    std::uint32_t hostSlot,codecRevision,scale,steps;
    double min,max,defaultValue;
};
bool fw_native_copy_generic_codec(
    const FWNativeOpaque* handle,std::uint32_t hostSlot,
    FWNativeGenericCodec* out);
// NON-RT read-only WASM-authored semantic name for slot64..127. Returns
// 1..128 ASCII bytes plus trailing NUL, or 0 without writing. The buffer
// must have at least returned-length+1 bytes; a positive read is NOT
// authorization to edit DAW parameters or create a saved FWS3 ledger.
std::uint32_t fw_native_copy_generic_semantic_id(
    const FWNativeOpaque* handle,std::uint32_t hostSlot,
    std::uint8_t* out,std::size_t capacity);
// NON-RT read-only WHOLE-descriptor proof: all requested slots must match
// the same verified WASM's engine hash, semantic IDs and numeric dimensions.
// Returns exact candidate mask or 0. NOT permission to edit DAW/RT events.
std::uint64_t fw_native_attest_generic_descriptor_mask(
    const FWNativeOpaque* handle,const std::uint8_t* descriptor_json,
    std::size_t descriptor_len);
// R3C2D2 non-RT, live-WASM attestation for the WHOLE UI descriptor set.
// All submitted bindings must match engine/package SHA and WASM-owned
// semantic ID, numeric range, scale, dimensions, default and codec.
// Returns candidate mask ONLY; no UI, DAW, saved-ledger or RT permission.
// On rejection the caller's output is untouched.
bool fw_native_attest_generic_descriptor_set(
    const FWNativeOpaque* handle,const std::uint8_t* descriptor_json,
    std::size_t descriptor_len,std::uint64_t* selected_mask);
// NON-RT necessary-only JSON descriptor preflight; positive result alone
// NEVER authorizes new audio events or saved DAW generic automation.
bool fw_native_preflight_generic_descriptor(
    const FWNativeOpaque* handle,const std::uint8_t* descriptor_json,
    std::size_t descriptor_len,std::uint32_t host_slot,
    const std::uint8_t* semantic_id,std::size_t semantic_len,
    std::uint32_t codec_revision);
std::int32_t fw_native_process(
    FWNativeOpaque* handle, const float* input, float* output,
    std::uint32_t frames, const FWNativeEvent* events, std::uint32_t event_count);
}
static_assert(sizeof(FWNativeGenericCodec)==40 &&
              alignof(FWNativeGenericCodec)==8,
              "WASM-authored generic codec ABI shape changed");
static_assert(sizeof(FWNativeEvent)==16,"v1 event ABI layout changed");
static_assert(alignof(FWNativeEvent)==8,"v1 event ABI alignment changed");
