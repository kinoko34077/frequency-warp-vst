//! ABI S3b. Caller must own pointer lifetime; prepare/destroy are NON real-time.
//! Successful process path uses caller-supplied separate audio buffers.
use crate::{ParamEvent,Runtime};
use std::{panic::{catch_unwind,AssertUnwindSafe},ptr,slice};

// ABI handshake is called by VST3 Processor::initialize outside RT.
#[no_mangle]
pub extern "C" fn fw_native_abi_major() -> u32 { 1 }

pub struct Opaque {runtime:Runtime,channels:usize}
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
            .ok().map(|runtime|Box::new(Opaque{runtime,channels:channels as usize}))
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
// Worker-only capability negotiation, value is a bitset of immutable ParamIDs.
// Older single-file modules without the export are limited to IDs2..5.
#[no_mangle]
pub unsafe extern "C" fn fw_native_stream_control_mask(handle:*const Opaque)->u64 {
    if handle.is_null(){return 0;}
    (*handle).runtime.stream_control_mask()
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
