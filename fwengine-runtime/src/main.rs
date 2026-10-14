use anyhow::{ensure, Context, Result};
use fwengine_runtime::{ParamEvent, Runtime};

fn main()->Result<()> {
    let files:Vec<_>=std::env::args().skip(1).collect();
    ensure!(files.len()==2,"usage: fwengine-runtime Identity.fwengine Gain.fwengine");
    let a=std::fs::read(&files[0]).context("read first .fwengine")?;
    let b=std::fs::read(&files[1]).context("read second .fwengine")?;
    let mut identity=Runtime::prepare(&a,48000.,2,256)?;
    let mut gain=Runtime::prepare(&b,48000.,2,256)?;
    let input=vec![0.8f32;512];
    let original=identity.process(&input,256,&[])?;
    let changed=gain.process(&input,256,&[])?;
    ensure!(original.iter().all(|x|(x-0.8).abs()<1e-5)
         && changed.iter().all(|x|(x-0.4).abs()<1e-5),"module file-only swap PCM incorrect");
    let automated=gain.process(&input,256,&[ParamEvent{id:64,offset:128,value:0.25}])?;
    ensure!((automated[0]-0.4).abs()<1e-5
        && (automated[127]-0.4).abs()<1e-5
        && (automated[128]-0.2).abs()<1e-5,"sample offset automation failed");
    let zero=gain.process(&[],0,&[ParamEvent{id:64,offset:0,value:0.75}])?;
    ensure!(zero.is_empty(),"zero-frame flush produced audio");
    ensure!((gain.process(&input,256,&[])?[0]-0.6).abs()<1e-5,"zero-frame flush failed");
    ensure!(Runtime::prepare(b"not a ZIP",48000.,2,256).is_err(),"invalid archive passed");
    let high=gain.process(&input,256,&[ParamEvent{id:64,offset:0,value:2.0}])?;
    ensure!((high[0]-1.6).abs()<1e-5,"canonical gain domain 0..4 mismatch");
    ensure!(gain.process(&input,256,&[ParamEvent{id:65,offset:0,value:0.5}]).is_err(),
       "unbound generic parameter silently bound");
    ensure!(identity.process(&[f32::NAN],1,&[]).is_err(),"bad PCM accepted");

    // Exercise the exported stable C ABI without rebuilding the native harness.
    // Still NON-RT: both preparation and process allocate inside the interpreter.
    use fwengine_runtime::ffi::{
        fw_native_abi_major_v1,fw_native_prepare_v1,fw_native_latency_v1,
        fw_native_process_nonrt_v1,fw_native_release_v1
    };
    ensure!(fw_native_abi_major_v1()==1,"native C ABI major mismatch");
    let a_handle=unsafe{fw_native_prepare_v1(a.as_ptr(),a.len(),48000.,2,256)};
    let b_handle=unsafe{fw_native_prepare_v1(b.as_ptr(),b.len(),48000.,2,256)};
    ensure!(!a_handle.is_null()&&!b_handle.is_null(),"C ABI failed module preparation");
    ensure!(unsafe{fw_native_latency_v1(a_handle)}==0&&
        unsafe{fw_native_latency_v1(b_handle)}==0,"native ABI latency mismatch");
    let mut out_a=vec![0f32;512];
    let mut out_b=vec![0f32;512];
    let xa=unsafe{fw_native_process_nonrt_v1(a_handle,input.as_ptr(),out_a.as_mut_ptr(),
        256,std::ptr::null(),0)};
    let xb=unsafe{fw_native_process_nonrt_v1(b_handle,input.as_ptr(),out_b.as_mut_ptr(),
        256,std::ptr::null(),0)};
    ensure!(xa==0&&xb==0,"C ABI processing failed");
    ensure!(out_a.iter().all(|x|(*x-.8).abs()<1e-5)&&
        out_b.iter().all(|x|(*x-.4).abs()<1e-5),
        "C ABI failed Identity/Gain file-only audio difference");
    let event=[ParamEvent{id:64,offset:128,value:.25}];
    ensure!(unsafe{fw_native_process_nonrt_v1(b_handle,input.as_ptr(),
        out_b.as_mut_ptr(),256,event.as_ptr(),1)}==0,"native sample-offset event failed");
    ensure!((out_b[127]-.4).abs()<1e-5&&(out_b[128]-.2).abs()<1e-5,
        "native ABI lost automation sample offset");
    let flushed=[ParamEvent{id:64,offset:0,value:.75}];
    ensure!(unsafe{fw_native_process_nonrt_v1(b_handle,std::ptr::null(),
        std::ptr::null_mut(),0,flushed.as_ptr(),1)}==0,"native zero-frame flush failed");
    ensure!(unsafe{fw_native_process_nonrt_v1(b_handle,input.as_ptr(),
        out_b.as_mut_ptr(),256,std::ptr::null(),0)}==0&&
        (out_b[0]-.6).abs()<1e-5,"native zero-frame event state lost");
    ensure!(unsafe{fw_native_prepare_v1(b"broken zip".as_ptr(),10,48000.,2,256)}.is_null(),
        "malformed native module accepted");
    unsafe{fw_native_release_v1(a_handle);fw_native_release_v1(b_handle);}
    println!("PASS native WASM and C ABI file-only DSP swap, audio, automation, zero-frame and malformed rejects");
    Ok(())
}
