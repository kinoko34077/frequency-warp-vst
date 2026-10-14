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
    // Native C ABI boundary must reproduce PCM without a host Vec allocation.
    use fwengine_runtime::ffi::{fw_native_prepare,fw_native_process,fw_native_destroy,fw_native_latency};
    let handle=unsafe{fw_native_prepare(a.as_ptr(),a.len(),48000.,2,256)};
    ensure!(!handle.is_null(),"C ABI prepare rejected known-good package");
    let mut output=vec![0.0f32;512];
    let rc=unsafe{fw_native_process(handle,input.as_ptr(),output.as_mut_ptr(),256,
        std::ptr::null(),0)};
    ensure!(rc==0&&output.iter().all(|v|(v-0.8).abs()<1e-5),"C ABI PCM mismatch");
    ensure!(unsafe{fw_native_latency(handle)}==0,"C ABI latency incorrect");
    ensure!(unsafe{fw_native_process(handle,input.as_ptr(),input.as_ptr() as *mut f32,
        256,std::ptr::null(),0)}!=0,"unsafe aliased host pointer accepted");
    unsafe{fw_native_destroy(handle)};
    println!("PASS native WASM single-file DSP swap, audio, automation, zero-frame and malformed rejects");
    Ok(())
}
