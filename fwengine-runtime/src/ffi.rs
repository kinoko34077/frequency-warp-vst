//! ABI S3b. Caller must own pointer lifetime; prepare/destroy are NON real-time.
//! Successful process path uses caller-supplied separate audio buffers.
use crate::{ParamEvent,Runtime};
use std::{panic::{catch_unwind,AssertUnwindSafe},ptr,slice};
use sha2::{Digest,Sha256};

// ABI handshake is called by VST3 Processor::initialize outside RT.
#[no_mangle]
pub extern "C" fn fw_native_abi_major() -> u32 { 1 }

pub struct Opaque {runtime:Runtime,channels:usize,package_hash:[u8;32]}
#[repr(C)]
pub struct NativeGenericCodec {
    pub host_slot:u32,
    pub codec_revision:u32,
    pub scale:u32, // 0 linear, 1 log, 2 discrete, 3 band, 4 zero
    pub steps:u32,
    pub min:f64,
    pub max:f64,
    pub default_value:f64,
}

#[no_mangle]
pub unsafe extern "C" fn fw_native_prepare(
    data:*const u8,length:usize,rate:f64,channels:u32,max_frames:u32
)->*mut Opaque {
    if data.is_null()||length<30||length>8*1024*1024||
       !(1..=2).contains(&channels)||max_frames==0||max_frames>2048{
        return ptr::null_mut();
    }
    match catch_unwind(AssertUnwindSafe(||{
        let bytes=slice::from_raw_parts(data,length);
        Runtime::prepare(bytes,rate,channels as usize,max_frames as usize)
            .ok().map(|runtime|{
                let mut package_hash=[0u8;32];
                package_hash.copy_from_slice(&Sha256::digest(bytes));
                Box::new(Opaque{runtime,channels:channels as usize,package_hash})
            })
    })){
        Ok(Some(engine))=>Box::into_raw(engine),
        _=>ptr::null_mut(),
    }
}
#[no_mangle]
pub unsafe extern "C" fn fw_native_destroy(handle:*mut Opaque){
    if handle.is_null(){return;}
    // Only call on worker/UI thread after confirming no audio callback uses handle.
    let _=catch_unwind(AssertUnwindSafe(||drop(Box::from_raw(handle))));
}
#[no_mangle]
pub unsafe extern "C" fn fw_native_latency(handle:*const Opaque)->u32{
    if handle.is_null(){return u32::MAX;}
    (*handle).runtime.manifest.nominal_latency_frames
}
#[no_mangle]
pub unsafe extern "C" fn fw_native_faulted(handle:*const Opaque)->bool{
    handle.is_null()||(*handle).runtime.faulted()
}
#[no_mangle]
pub unsafe extern "C" fn fw_native_supports_stream_controls(handle:*const Opaque)->bool{
    // Worker-only module identity test. Generic ID64 demo modules must never
    // receive spectral IDs2..5 and trip their own strict parameter contract.
    !handle.is_null()&&(*handle).runtime.manifest.engine_id=="org.kinotch.stream"
}
/// NON-RT only, read-only identity from a successfully prepared and verified
/// engine. Returns byte length of ASCII engine ID (no trailing NUL) or 0.
//// Caller supplies disjoint writable buffers: 32 SHA256 bytes and at least
/// 129 bytes for engine ID. Digest is of the exact entire .fwengine ZIP,
/// not the manifest's hash of engine.wasm and not an authenticity signature.
#[no_mangle]
pub unsafe extern "C" fn fw_native_copy_verified_identity(
    handle:*const Opaque, sha_out:*mut u8,sha_capacity:usize,
    engine_out:*mut u8,engine_capacity:usize
)->u32 {
    if handle.is_null()||sha_out.is_null()||engine_out.is_null()||
       sha_capacity<32||sha_capacity>32||engine_capacity==0||
       engine_capacity>129{return 0;}
    let e=(*handle).runtime.manifest.engine_id.as_bytes();
    if e.is_empty()||e.len()>128||engine_capacity<=e.len() {return 0;}
    if intersects(sha_out as usize,32,engine_out as usize,e.len()+1) {
        return 0;
    }
    // The caller owns valid, non-aliasing writable buffers. The source
    // Opaque and its immutable engine identity remain worker-owned.
    ptr::copy_nonoverlapping((*handle).package_hash.as_ptr(),sha_out,32);
    ptr::copy_nonoverlapping(e.as_ptr(),engine_out,e.len());
    *engine_out.add(e.len())=0;
    e.len() as u32
}
// Worker-only capability negotiation, value is a bitset of immutable ParamIDs.
// Older single-file modules without the export are limited to IDs2..5.
#[no_mangle]
pub unsafe extern "C" fn fw_native_stream_control_mask(handle:*const Opaque)->u64 {
    if handle.is_null(){return 0;}
    (*handle).runtime.stream_control_mask()
}
// R3A non-RT verified engine capability. Bit0 corresponds to Host ParamID64.
// No semantic permissions are granted by this read-only mask alone.
#[no_mangle]
pub unsafe extern "C" fn fw_native_generic_slot_mask(handle:*const Opaque)->u64 {
    if handle.is_null(){return 0;}
    (*handle).runtime.generic_slot_mask()
}
// R3C1 NON-RT validation only; does not authorize DAW events.
// R3C2 must still match active FWS3 ledger, generation and trusted UI
// descriptor before calling any worker route for these slots.
#[no_mangle]
pub unsafe extern "C" fn fw_native_generic_value_in_contract(
    handle:*const Opaque,slot:u32,value:f64
)->bool {
    if handle.is_null()||!(64..=127).contains(&slot){return false;}
    let rt=&(*handle).runtime;
    rt.generic_slot_mask()&(1u64<<(slot-64))!=0 &&
        rt.generic_contract(slot).is_some_and(|b|b.contains_event_value(value))
}
/// R3C2C0: read numeric codec from the WASM-authored semantic contract,
/// NOT from the replaceable HTML UI descriptor. Only call on the non-RT
/// native worker while the verified handle is owned and still alive.
/// A positive result alone is NOT host/DAW authorization.
#[no_mangle]
pub unsafe extern "C" fn fw_native_copy_generic_codec(
    handle:*const Opaque,slot:u32,out:*mut NativeGenericCodec
)->bool {
    if handle.is_null()||out.is_null()||!(64..=127).contains(&slot)||
       (out as usize)%std::mem::align_of::<NativeGenericCodec>()!=0{
        return false;
    }
    let rt=&(*handle).runtime;
    if rt.generic_slot_mask()&(1u64<<(slot-64))==0{return false;}
    let Some(binding)=rt.generic_contract(slot) else{return false};
    let scale=match binding.scale.as_str(){
        "linear"=>0,"log"=>1,"discrete"=>2,
        "frequency-band"=>3,"frequency-with-zero"=>4,
        _=>return false,
    };
    let candidate=NativeGenericCodec {
        host_slot:binding.host_slot,
        codec_revision:binding.codec_revision,
        scale,
        steps:binding.steps.unwrap_or(0),
        min:binding.min,max:binding.max,
        default_value:binding.default,
    };
    ptr::write(out,candidate);
    true
}
/// R3C2D1: copy the canonical semantic ID authored by the *same live*
/// verified WASM module, not from replaceable HTML/UI descriptor JSON.
/// Non-RT worker only. Positive return is an identity read, not DAW authority.
/// Returns ASCII byte length (excluding NUL) or 0; out is untouched on deny.
#[no_mangle]
pub unsafe extern "C" fn fw_native_copy_generic_semantic_id(
    handle:*const Opaque,slot:u32,out:*mut u8,capacity:usize
)->u32 {
    if handle.is_null()||out.is_null()||!(64..=127).contains(&slot){
        return 0;
    }
    let runtime=&(*handle).runtime;
    if runtime.generic_slot_mask()&(1u64<<(slot-64))==0{return 0;}
    let Some(contract)=runtime.generic_contract(slot) else{return 0};
    let id=contract.semantic_id.as_bytes();
    if id.is_empty()||id.len()>128||capacity<id.len()+1{return 0;}
    ptr::copy_nonoverlapping(id.as_ptr(),out,id.len());
    ptr::write(out.add(id.len()),0);
    id.len() as u32
}
/// R3C2D2: validate an ENTIRE candidate UI descriptor against verified
/// package identity, declared mask, and all WASM-authored canonical contracts.
/// Non-RT worker only. A mask is read-only evidence, not binding permission.
#[no_mangle]
pub unsafe extern "C" fn fw_native_attest_generic_descriptor_mask(
    handle:*const Opaque,json:*const u8,json_len:usize
)->u64 {
    if handle.is_null()||json.is_null()||json_len==0||json_len>65536{
        return 0;
    }
    catch_unwind(AssertUnwindSafe(||{
        let native=&*handle;
        let rt=&native.runtime;
        let data=slice::from_raw_parts(json,json_len);
        crate::descriptor::attested_mask(
            data,&rt.manifest.engine_id,&native.package_hash,
            rt.generic_slot_mask(),|slot|rt.generic_contract(slot)
        ).unwrap_or(0)
    })).unwrap_or(0)
}
/// R3C2D2: attest the ENTIRE externally supplied descriptor set against
/// the same verified engine's immutable WASM-authored canonical contracts.
/// Returns the candidate slot bitmask; never grants DAW/RT permission.
#[no_mangle]
pub unsafe extern "C" fn fw_native_attest_generic_descriptor_set(
    handle:*const Opaque,json:*const u8,json_len:usize,
    out_mask:*mut u64
)->bool {
    if handle.is_null()||json.is_null()||out_mask.is_null()||
       json_len==0||json_len>65536||
       (out_mask as usize)%std::mem::align_of::<u64>()!=0{return false;}
    catch_unwind(AssertUnwindSafe(||{
        let o=&*handle;
        let data=slice::from_raw_parts(json,json_len);
        let Some(mask)=crate::descriptor::attest_entire_descriptor_set(
            data,&o.runtime.manifest.engine_id,&o.package_hash,
            o.runtime.generic_slot_mask(),
            |slot|o.runtime.generic_contract(slot).cloned()
        ) else{return false;};
        ptr::write(out_mask,mask);
        true
    })).unwrap_or(false)
}
/// R3B2 necessary-only NON-RT descriptor preflight, NOT DAW edit authority.
/// Validate exact native worker-prepared engine/hash, declared capability mask,
/// JSON schema/units/ranges and caller-requested semantic ID+codec.
/// This cannot attest that WASM implements the descriptor's physical range;
/// R3B3/3C must establish module-owned semantic proof and saved-FWS3 identity.
#[no_mangle]
pub unsafe extern "C" fn fw_native_preflight_generic_descriptor(
    handle:*const Opaque, json:*const u8, json_len:usize,
    slot:u32, semantic:*const u8, semantic_len:usize, codec_revision:u32
)->bool {
    if handle.is_null() || json.is_null() || semantic.is_null() ||
       json_len==0 || json_len>65536 || semantic_len==0 ||
       semantic_len>128 || !(64..=127).contains(&slot) ||
       codec_revision==0 || codec_revision>65535 {return false;}
    catch_unwind(AssertUnwindSafe(||{
        let Some(id)=std::str::from_utf8(slice::from_raw_parts(semantic,semantic_len)).ok()
        else{return false;};
        let o=&*handle;
        let data=slice::from_raw_parts(json,json_len);
        crate::descriptor::preflight(
            data,&o.runtime.manifest.engine_id,
            &o.package_hash,o.runtime.generic_slot_mask(),
            slot,id,codec_revision) &&
        o.runtime.generic_contract(slot).is_some_and(|canonical|
            crate::descriptor::matches_wasm_semantics(data,canonical))
    })).unwrap_or(false)
}
fn intersects(a:usize,a_len:usize,b:usize,b_len:usize)->bool {
    match (a.checked_add(a_len),b.checked_add(b_len)){
        (Some(a_end),Some(b_end))=>a<b_end && b<a_end,
        _=>true,
    }
}
#[no_mangle]
pub unsafe extern "C" fn fw_native_process(
    handle:*mut Opaque, input:*const f32, output:*mut f32,
    frames:u32, events:*const ParamEvent, event_count:u32
)->i32 {
    if handle.is_null()||event_count>128{return -1;}
    let opaque=&mut *handle;
    let samples=match (frames as usize).checked_mul(opaque.channels){
        Some(n) if n<=4096=>n,
        _=>return -1,
    };
    let bytes=match samples.checked_mul(std::mem::size_of::<f32>()){
        Some(n)=>n,None=>return -1,
    };
    if samples>0&&(input.is_null()||output.is_null()||
       (input as usize)%4!=0||(output as usize)%4!=0||
       intersects(input as usize,bytes,output as usize,bytes)){
        return -1; // no alias, even in-place DAW audio must be copied in shell
    }
    if event_count>0&&(events.is_null()||
       (events as usize)%std::mem::align_of::<ParamEvent>()!=0){
        return -1;
    }
    if event_count>0&&samples>0{
        let e_bytes=event_count as usize*std::mem::size_of::<ParamEvent>();
        if intersects(events as usize,e_bytes,input as usize,bytes)||
           intersects(events as usize,e_bytes,output as usize,bytes){return -1;}
    }
    let empty_in:&[f32]=&[];
    let mut empty_out:[f32;0]=[];
    let in_slice=if samples==0{empty_in}else{slice::from_raw_parts(input,samples)};
    let out_slice=if samples==0{&mut empty_out[..]}
        else{slice::from_raw_parts_mut(output,samples)};
    let empty_events:&[ParamEvent]=&[];
    let event_slice=if event_count==0{empty_events}
        else{slice::from_raw_parts(events,event_count as usize)};
    match catch_unwind(AssertUnwindSafe(||opaque.runtime.process_into(
        in_slice,out_slice,frames as usize,event_slice
    ))){
        Ok(Ok(()))=>0,
        Ok(Err(_))=>-2,
        Err(_)=>-3,
    }
}
#[cfg(test)]
mod tests{
    use super::*;
    #[test] fn alias_checked(){
        assert!(intersects(100,20,110,10));
        assert!(!intersects(100,20,120,10));
        assert!(intersects(usize::MAX,10,0,1));
    }
    #[test] fn ffi_layout(){
        assert_eq!(std::mem::size_of::<ParamEvent>(),16);
        assert_eq!(std::mem::align_of::<ParamEvent>(),8);
    }
}
