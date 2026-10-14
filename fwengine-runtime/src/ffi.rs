//! S3b0 fixed native C ABI boundary: NON-REALTIME ONLY.
//! All entry points must run on a serialized non-audio worker thread. The
//! underlying S3a interpreter may allocate and use bounded host CPU; this
//! layer is NOT permitted inside VST3 IAudioProcessor::process().
use crate::{ParamEvent,Runtime};
use std::ffi::c_void;
use std::panic::{catch_unwind,AssertUnwindSafe};
use std::ptr::NonNull;

pub const FW_NATIVE_ABI_MAJOR:u32=1;
struct HostInstance { engine:Runtime, channels:usize, max_frames:usize }
fn guard<T>(operation:impl FnOnce()->T)->Option<T>{
    catch_unwind(AssertUnwindSafe(operation)).ok()
}
#[no_mangle]
pub extern "C" fn fw_native_abi_major_v1()->u32 {FW_NATIVE_ABI_MAJOR}
/// Caller guarantees bytes points to length readable bytes until this returns.
/// Returns an opaque null pointer on invalid content, unsupported settings,
/// import/fuel/memory/ABI validation failure or panic.
#[no_mangle]
pub unsafe extern "C" fn fw_native_prepare_v1(
    bytes:*const u8, length:usize, sample_rate:f64,
    channels:u32, max_frames:u32
)->*mut c_void {
    if bytes.is_null()||length==0||length>fwengine_package::MAX_PACKAGE_BYTES
        ||!(channels==1||channels==2)||max_frames==0||max_frames>2048 {return std::ptr::null_mut();}
    guard(||{
        let archive=unsafe {std::slice::from_raw_parts(bytes,length)};
        match Runtime::prepare(archive,sample_rate,channels as usize,max_frames as usize){
            Ok(engine)=>Box::into_raw(Box::new(HostInstance{
                engine,channels:channels as usize,max_frames:max_frames as usize
            })) as *mut c_void,
            Err(_)=>std::ptr::null_mut()
        }
    }).unwrap_or(std::ptr::null_mut())
}
/// Manifest-declared module latency, <=4095. Returns -1 on null/broken handle.
/// The pointer is only valid until fw_native_release_v1; no concurrent access.
#[no_mangle]
pub unsafe extern "C" fn fw_native_latency_v1(handle:*const c_void)->i32{
    if handle.is_null(){return -1;}
    guard(||{
        let instance=unsafe{&*(handle as *const HostInstance)};
        instance.engine.manifest.nominal_latency_frames as i32
    }).unwrap_or(-1)
}
/// Non-real-time processing. Input and output are planar (channel * frames)
/// f32 buffers. In-place caller pointers are safe because Runtime::process
/// returns a separate Vec; NEVER call from the audio callback.
/// Event pointers contain 16-byte little endian repr(C) {u32,u32,f64}.
/// Return: 0 success, -1 invalid arguments, -2 module error/fault/trap.
/// A module failure leaves already-running other handles untouched.
#[no_mangle]
pub unsafe extern "C" fn fw_native_process_nonrt_v1(
    handle:*mut c_void, in_f32:*const f32, out_f32:*mut f32,
    frames:u32, events:*const ParamEvent, event_count:u32
)->i32 {
    if handle.is_null()||event_count>8192||
       (event_count>0&&events.is_null()){return -1;}
    let Some(instance)=NonNull::new(handle as *mut HostInstance) else {return -1};
    // SAFETY: host uses this handle on ONE serialized non-RT worker and never
    // simultaneously passes it to release/process. Its lifetime is owned by host.
    let inst=unsafe {&mut *instance.as_ptr()};
    if frames as usize>inst.max_frames{return -1;}
    let Some(size)=inst.channels.checked_mul(frames as usize) else {return -1};
    if size>0&&(in_f32.is_null()||out_f32.is_null()){return -1;}
    guard(||{
        let input:&[f32]=if size==0 {&[]}else{
            unsafe{std::slice::from_raw_parts(in_f32,size)}
        };
        let ev:&[ParamEvent]=if event_count==0 {&[]}else{
            unsafe{std::slice::from_raw_parts(events,event_count as usize)}
        };
        match inst.engine.process(input,frames as usize,ev) {
            Ok(result) if result.len()==size=>{
                if size>0{
                    unsafe{std::ptr::copy_nonoverlapping(result.as_ptr(),out_f32,size);}
                }
                0
            }
            _ => -2
        }
    }).unwrap_or(-2)
}
/// Release on the same non-audio worker after the host stops using the handle.
#[no_mangle]
pub unsafe extern "C" fn fw_native_release_v1(handle:*mut c_void) {
    if handle.is_null(){return;}
    let _=guard(||{
        unsafe{drop(Box::from_raw(handle as *mut HostInstance));}
    });
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]fn null_and_invalid_archive_fail_safely(){
        assert_eq!(fw_native_abi_major_v1(),1);
        assert_eq!(unsafe{fw_native_latency_v1(std::ptr::null())},-1);
        assert!(unsafe{fw_native_prepare_v1(std::ptr::null(),0,48000.,2,128)}.is_null());
        let bad=b"not a module";
        assert!(unsafe{fw_native_prepare_v1(bad.as_ptr(),bad.len(),48000.,2,128)}.is_null());
        assert_eq!(unsafe{fw_native_process_nonrt_v1(std::ptr::null_mut(),
            std::ptr::null(),std::ptr::null_mut(),0,std::ptr::null(),0)},-1);
    }
}
