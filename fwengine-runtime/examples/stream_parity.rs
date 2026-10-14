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
    let dry_settings=native_settings;
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
    // A DAW is free to automate L and H independently. Even though each
    // canonical value fits its own range, their combination can be invalid.
    // The module must retain its previous working configuration (not TRAP
    // or mark Wasmi broken) and recover once a later packet supplies a
    // valid combined snapshot.
    let crossing=frame_input(BLOCKS*F,F);
    let invalid_pair=[
        ParamEvent{id:2,offset:0,value:18000.0},
        ParamEvent{id:3,offset:0,value:500.0}
    ];
    let retained=wasm.process(&crossing,F,&invalid_pair)?;
    let mut native_retained=vec![0f32;2*F];
    native.process(&crossing,&mut native_retained,F)?;
    assert!(!wasm.faulted(),"ordinary L>=H automation must not fault the module");
    assert!(retained.iter().zip(native_retained.iter())
        .all(|(x,y)|(x-y).abs()<0.008),
        "bad host pair must preserve last valid native spectral settings");

    let recovered_input=frame_input((BLOCKS+1)*F,F);
    let valid_pair=[
        ParamEvent{id:2,offset:0,value:500.0},
        ParamEvent{id:3,offset:0,value:8000.0}
    ];
    native_settings.low=500.0;native_settings.high=8000.0;
    native.configure(native_settings,0)?;
    let recovered=wasm.process(&recovered_input,F,&valid_pair)?;
    let mut native_recovered=vec![0f32;2*F];
    native.process(&recovered_input,&mut native_recovered,F)?;
    assert!(!wasm.faulted(),"valid host pair must recover rejected automation");
    assert!(recovered.iter().zip(native_recovered.iter())
        .all(|(x,y)|(x-y).abs()<0.008),
        "recovered valid pair must match canonical native Stream");

    // At sample rates below 32 kHz, fixed host-default Upper=16000 Hz
    // exceeds Nyquist. The VST3 may restore that stored host value; it must
    // not permanently fault a valid 8k module whose initial H is 3600 Hz.
    let mut low_rate=Runtime::prepare(&actual,8000.0,2,F)?;
    let low_input=frame_input(0,F);
    let low_events=[
        ParamEvent{id:2,offset:0,value:20.0},
        ParamEvent{id:3,offset:0,value:16000.0}
    ];
    let low_output=low_rate.process(&low_input,F,&low_events)?;
    assert!(!low_rate.faulted()&&low_output.iter().all(|v|v.is_finite()),
        "host default above low-rate Nyquist must retain valid 8k DSP");
    // Unsupported host param (e.g. Gain ID64) MUST fail on actual Stream,
    // while demo Identity/Gain native regression still accepts ID64.
    let buf=frame_input(16384,F);
    assert!(wasm.process(&buf,F,&[ParamEvent{id:64,offset:0,value:0.5}]).is_err());
    println!("PASS S4a canonical Rust Stream/native Wasmi PCM: 16384 frames, max_error={biggest:.7}, post_event_diff={after_diff:.4}, declared_latency=1023, bad_manifest_rejected");
    Ok(())
}
