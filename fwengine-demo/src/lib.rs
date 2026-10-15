//! Deterministic VST3 S1 file-swappable WASM fixture.
//! Only demonstration: final VST3 adapter reuses core/src/stream.rs, not this Gain DSP.
use std::ptr::{addr_of_mut, addr_of};

const MAX_CHANNELS: usize = 2;
const MAX_FRAMES: usize = 2048;
const MAX_EVENTS: usize = 128;
const MAX_SAMPLES: usize = MAX_CHANNELS * MAX_FRAMES;
const INITIAL_GAIN: f64 = if cfg!(feature = "gain-half") { 0.5 } else { 1.0 };
const HANDLE: u32 = 1;

#[repr(C)]
#[derive(Copy, Clone)]
pub struct Event {
    pub host_param_id: u32,
    pub sample_offset: u32,
    pub canonical_value: f64,
}

static mut INPUT: [f32; MAX_SAMPLES] = [0.0; MAX_SAMPLES];
static mut OUTPUT: [f32; MAX_SAMPLES] = [0.0; MAX_SAMPLES];
static mut EVENTS: [Event; MAX_EVENTS] = [Event {
    host_param_id: 64, sample_offset: 0, canonical_value: 1.0
}; MAX_EVENTS];
static mut CHANNELS: usize = 0;
static mut GAIN: f64 = INITIAL_GAIN;

#[no_mangle] pub extern "C" fn fw_abi_major() -> u32 { 1 }
// Optional v1 generic-slot capability: bit0=stable Host ParamID64.
// Older engines without this export report no generic slot permission.
#[cfg(not(feature = "legacy-no-generic-mask"))]
#[no_mangle] pub extern "C" fn fw_supported_generic_slot_mask() -> u64 { 1u64 }

// R3B3: module-owned canonical semantics, independent from external UI labels
// and from the full package digest (which cannot be embedded recursively).
// All authored bytes are part of the previously verified WASM package.
// Optional exports deliberately absent for old legacy demo packages.
#[cfg(not(feature = "legacy-no-generic-mask"))]
static GENERIC_CONTRACT:&[u8]=if cfg!(feature="gain-half") {
    br#"{"schema":"frequency-warp-wasm-semantics-v1","bindings":[{"host_slot":64,"semantic_id":"gain","codec_revision":1,"dimension":"signedRatio","canonical_unit":"ratio","min":0,"max":4,"default":0.5,"scale":"linear"}]}"#
} else {
    br#"{"schema":"frequency-warp-wasm-semantics-v1","bindings":[{"host_slot":64,"semantic_id":"gain","codec_revision":1,"dimension":"signedRatio","canonical_unit":"ratio","min":0,"max":4,"default":1,"scale":"linear"}]}"#
};
#[cfg(not(feature = "legacy-no-generic-mask"))]
#[no_mangle] pub extern "C" fn fw_generic_contract_offset()->u32 {
    GENERIC_CONTRACT.as_ptr() as usize as u32
}
#[cfg(not(feature = "legacy-no-generic-mask"))]
#[no_mangle] pub extern "C" fn fw_generic_contract_length()->u32 {
    GENERIC_CONTRACT.len() as u32
}


#[no_mangle] pub extern "C" fn fw_input_offset() -> u32 { addr_of!(INPUT) as usize as u32 }
#[no_mangle] pub extern "C" fn fw_output_offset() -> u32 { addr_of_mut!(OUTPUT) as usize as u32 }
#[no_mangle] pub extern "C" fn fw_event_offset() -> u32 { addr_of_mut!(EVENTS) as usize as u32 }
#[no_mangle] pub extern "C" fn fw_event_capacity() -> u32 { MAX_EVENTS as u32 }
#[no_mangle] pub extern "C" fn fw_event_stride() -> u32 { std::mem::size_of::<Event>() as u32 }

#[no_mangle]
pub extern "C" fn fw_create(rate: f64, channels: u32, max_block: u32) -> u32 {
    if !rate.is_finite() || !(8000.0..=384000.0).contains(&rate)
        || !(1..=MAX_CHANNELS as u32).contains(&channels)
        || max_block == 0 || max_block > MAX_FRAMES as u32 { return 0; }
    unsafe {
        CHANNELS = channels as usize;
        GAIN = INITIAL_GAIN;
    }
    HANDLE
}
#[no_mangle]
pub extern "C" fn fw_get_latency_frames(handle: u32) -> u32 {
    if handle == HANDLE { 0 } else { u32::MAX }
}
#[no_mangle]
pub extern "C" fn fw_reset(handle: u32) -> i32 {
    if handle != HANDLE { return -1; }
    unsafe { GAIN = INITIAL_GAIN; }
    0
}
#[no_mangle]
pub extern "C" fn fw_destroy(handle: u32) {
    if handle == HANDLE { unsafe { CHANNELS = 0; } }
}
#[no_mangle]
pub extern "C" fn fw_process(
    handle: u32, input_offset: u32, output_offset: u32,
    frames: u32, event_offset: u32, event_count: u32
) -> i32 {
    if handle != HANDLE || input_offset != fw_input_offset()
        || output_offset != fw_output_offset() || event_offset != fw_event_offset()
        || frames > MAX_FRAMES as u32 || event_count > MAX_EVENTS as u32 { return -1; }
    unsafe {
        let ch = CHANNELS;
        if ch == 0 { return -1; }
        // Host zero-sample calls may contain parameter flushes.
        // They must change canonical state without reading audio buffers.
        if frames == 0 {
            for i in 0..event_count as usize {
                let event = EVENTS[i];
                if event.sample_offset != 0 || event.host_param_id != 64
                    || !event.canonical_value.is_finite()
                    || !(0.0..=4.0).contains(&event.canonical_value) { return -2; }
                GAIN = event.canonical_value;
            }
            return 0;
        }
        // Two distinct static arrays, no in-place alias and no heap work.
        let mut next = 0_usize;
        for frame in 0..frames as usize {
            while next < event_count as usize && EVENTS[next].sample_offset == frame as u32 {
                let event = EVENTS[next];
                if event.host_param_id != 64 || !event.canonical_value.is_finite()
                    || !(0.0..=4.0).contains(&event.canonical_value) { return -2; }
                GAIN = event.canonical_value;
                next += 1;
            }
            if next < event_count as usize && EVENTS[next].sample_offset < frame as u32 {
                return -3; // Events must be sorted by sample offset.
            }
            for channel in 0..ch {
                let i = channel * frames as usize + frame;
                OUTPUT[i] = (INPUT[i] as f64 * GAIN) as f32;
            }
        }
        if next != event_count as usize { return -3; }
    }
    0
}
