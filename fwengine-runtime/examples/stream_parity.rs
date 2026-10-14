//! S4a: actual core::Stream native vs the SAME DSP via Wasmi .fwengine
//! wrapper. Exit nonzero on PCM/latency/automation divergence.
use frequency_warp_core::{Progression,Settings,Stream};
use fwengine_runtime::{ParamEvent,Runtime};
use std::error::Error;
use std::f64::consts::PI;

fn frame_input(start:usize,frames:usize)->Vec<f32>{
    let mut result=vec![0.0f32;2*frames];
    for c in 0..2 {
        for i in 0..frames {
            let t=(start+i) as f64/48000.;
            result[c*frames+i]=(0.35*(2.*PI*330.*t).sin()
                +0.23*(2.*PI*731.*t).sin()
                +0.08*(2.*PI*1251.*t).sin()) as f32 *if c==0{1.0}else{0.73};
        }
    }
    result
}
fn native_chunk(stream:&mut Stream,src:&[f32],frames:usize,cut:usize,
                changed:&mut Settings)->Result<Vec<f32>,Box<dyn Error>>{
    let mut dst=vec![0f32;2*frames];
    let mut pos=0;
    while pos<frames {
        if pos==cut{
            changed.invert=0.72;
            changed.curvature=0.35;
            stream.configure(*changed,0)?;
        }
        let end=if pos<cut{cut}else{frames};
        let len=end-pos;
        if len==0{return Err("zero native PCM segment".into());}
        let mut inp=vec![0f32;2*len];let mut out=vec![0f32;2*len];
        for c in 0..2{
            inp[c*len..(c+1)*len].copy_from_slice(&src[c*frames+pos..c*frames+end]);
        }
        stream.process(&inp,&mut out,len)?;
        for c in 0..2 {
            dst[c*frames+pos..c*frames+end].copy_from_slice(&out[c*len..(c+1)*len]);
        }
        pos=end;
    }
    Ok(dst)
}
fn main()->Result<(),Box<dyn Error>>{
    let mut args=std::env::args().skip(1);
    let actual=std::fs::read(args.next().ok_or("need stream.fwengine")?)?;
    let wrong=std::fs::read(args.next().ok_or("need bad-latency.fwengine")?)?;
    let mut wasm=Runtime::prepare(&actual,48000.,2,128)?;
    assert_eq!(wasm.manifest.engine_id,"org.kinotch.stream");
    assert_eq!(wasm.manifest.nominal_latency_frames,1023);
    assert!(Runtime::prepare(&wrong,48000.,2,128).is_err(),
        "invalid declared Stream latency was not rejected");
    let mut native_settings=Settings{low:20.,high:16000.,curvature:1.,invert:0.,
        mode:Progression::Blend,quality:0};
    let mut native=Stream::new(48000.,2,native_settings,0)?;
    assert_eq!(native.latency(),1023);
    const F:usize=128;
    const BLOCKS:usize=128; // 16K samples, FFT warmup and live parameter sweep
    let mut biggest=0f32;let mut power=0f64;
    let mut after_diff=0f64;
    let mut dry_settings=native_settings;
    let mut unchanged=Stream::new(48000.,2,dry_settings,0)?;
    for block in 0..BLOCKS{
        let input=frame_input(block*F,F);
        let cut=if block==64{32}else{F};
        let events=if block==64{
            vec![ParamEvent{id:4,offset:32,value:0.72},
                 ParamEvent{id:5,offset:32,value:0.35}]
        }else{vec![]};
        let actual=wasm.process(&input,F,&events)?;
        let expected=native_chunk(&mut native,&input,F,cut,&mut native_settings)?;
        let mut baseline=vec![0.;2*F];
        unchanged.process(&input,&mut baseline,F)?;
        for ((a,b),z) in actual.iter().zip(expected.iter()).zip(baseline.iter()){
            biggest=biggest.max((a-b).abs());
            power+=(*a as f64)*(*a as f64);
            if block>=72 {after_diff+=((a-z) as f64).abs();}
        }
        assert!(actual.iter().all(|v|v.is_finite()),"bad real WASM audio");
    }
    assert!(power>1e-6,"shared Stream emitted no audio");
    assert!(after_diff>0.1,"L/H/Invert/Curvature event produced no audible PCM difference");
    assert!(biggest<0.008,"WASM/native canonical spectral PCM diverged: max={biggest}");
    // Unsupported host param (e.g. Gain ID64) MUST fail on actual Stream,
    // while demo Identity/Gain native regression still accepts ID64.
    let buf=frame_input(16384,F);
    assert!(wasm.process(&buf,F,&[ParamEvent{id:64,offset:0,value:.5}]).is_err());
    println!("PASS S4a canonical Rust Stream/native Wasmi PCM: 16384 frames, max_error={biggest:.7}, post_event_diff={after_diff:.4}, declared_latency=1023, bad_manifest_rejected");
    Ok(())
}
