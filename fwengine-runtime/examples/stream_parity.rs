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
                changed:&mut Settings,geometry_change:bool,crusher_change:bool,
                a_change:bool)->Result<Vec<f32>,Box<dyn Error>>{
    let mut dst=vec![0f32;2*frames];
    let mut pos=0;
    while pos<frames {
        if pos==cut{
            if geometry_change {
                // Same canonical Web AudioWorklet Stream setter calls:
                // transform, geometry, reflection amplitude and decay.
                stream.set_transform(0.4,350.,1,1)?;
                stream.set_geometry(500.,-0.6)?;
                stream.set_zero_reflect_gain(0.65)?;
                stream.set_zero_reflect_decay(0.4)?;
            }else if a_change {
                // Directly invoke Web's existing canonical Engine A setters.
                stream.set_a_options(70.0,0.55)?;
                stream.set_a_peak_band(3)?;
                stream.set_a_quality(65)?;
            }else if crusher_change {
                // Browser holdFromFrequency(12000 Hz,48000 Hz) = four frames.
                stream.set_crusher(6,4)?;
            }else{
                changed.invert=0.72;
                changed.curvature=0.35;
                stream.configure(*changed,0)?;
            }
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
    let mut crusher_diff=0f64;
    let mut engine_a_diff=0f64;
    let mut native_no_a=Stream::new(48000.,2,native_settings,0)?;
    let mut no_a_settings=native_settings;
    let mut native_without_crusher=Stream::new(48000.,2,native_settings,0)?;
    let mut no_crusher_settings=native_settings;
    let dry_settings=native_settings;
    let mut unchanged=Stream::new(48000.,2,dry_settings,0)?;
    for block in 0..BLOCKS{
        let input=frame_input(block*F,F);
        let cut=if block==64{32}else if block==80{40}else if block==96{24}else if block==112{20}else{F};
        let events=if block==64{
            vec![ParamEvent{id:4,offset:32,value:0.72},
                 ParamEvent{id:5,offset:32,value:0.35}]
        }else if block==80{
            vec![ParamEvent{id:6,offset:40,value:0.4},
                 ParamEvent{id:7,offset:40,value:500.0},
                 ParamEvent{id:8,offset:40,value:-0.6},
                 ParamEvent{id:9,offset:40,value:0.65},
                 ParamEvent{id:10,offset:40,value:1.0},
                 ParamEvent{id:13,offset:40,value:0.4},
                 ParamEvent{id:18,offset:40,value:1.0}]
        }else if block==96 {
            vec![ParamEvent{id:11,offset:24,value:1.0},
                 ParamEvent{id:16,offset:24,value:6.0},
                 ParamEvent{id:17,offset:24,value:12000.0}]
        }else if block==112 {
            vec![ParamEvent{id:27,offset:20,value:70.0},
                 ParamEvent{id:28,offset:20,value:0.65},
                 ParamEvent{id:29,offset:20,value:3.0},
                 ParamEvent{id:30,offset:20,value:0.55}]
        }else{vec![]};
        let actual=wasm.process(&input,F,&events)?;
        let expected=native_chunk(&mut native,&input,F,cut,&mut native_settings,
                                  block==80,block==96,block==112)?;
        let unmodified_a=native_chunk(&mut native_no_a,&input,F,
             if block==112{F}else{cut},&mut no_a_settings,
             block==80,block==96,false)?;
        let no_crusher=native_chunk(&mut native_without_crusher,&input,F,
            if block==96{F}else{cut},&mut no_crusher_settings,block==80,false,false)?;
        let mut baseline=vec![0.;2*F];
        unchanged.process(&input,&mut baseline,F)?;
        for ((a,b),z) in actual.iter().zip(expected.iter()).zip(baseline.iter()){
            biggest=biggest.max((a-b).abs());
            power+=(*a as f64)*(*a as f64);
            if block>=72 {after_diff+=((a-z) as f64).abs();}
        }
        if (104..112).contains(&block) {
            crusher_diff+=actual.iter().zip(no_crusher.iter())
                .map(|(a,b)|((*a-*b) as f64).abs()).sum::<f64>();
        }
        if block>=122 {
            engine_a_diff+=actual.iter().zip(unmodified_a.iter())
                .map(|(a,b)|((*a-*b) as f64).abs()).sum::<f64>();
        }
        assert!(actual.iter().all(|v|v.is_finite()),"bad real WASM audio");
    }
    assert!(power>1e-6,"shared Stream emitted no audio");
    assert!(after_diff>0.1,"canonical spectral and geometric events produced no PCM difference");
    assert!(crusher_diff>0.1,"crusher audio was a placebo after its sample-offset change");
    assert!(engine_a_diff>0.01,"Engine A setters had no audible PCM effect");
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
    // Zero-frame host flush: one event changes module settings without
    // advancing the PCM clock, then the same canonical native setter must
    // produce matching future samples.
    let zero=wasm.process(&[],0,&[
        ParamEvent{id:13,offset:0,value:0.2}])?;
    assert!(zero.is_empty()&&!wasm.faulted(),"zero-frame decay automation");
    native.set_zero_reflect_decay(0.2)?;
    let after_zero=frame_input((BLOCKS+2)*F,F);
    let wet_after_zero=wasm.process(&after_zero,F,&[])?;
    let mut native_after_zero=vec![0f32;2*F];
    native.process(&after_zero,&mut native_after_zero,F)?;
    assert!(wet_after_zero.iter().zip(native_after_zero.iter())
        .all(|(a,b)|(a-b).abs()<0.008),
        "zero-frame module parameter flush changed spectral stream timing");
    // DAW sample-clock 0 Hz is an intentional infinite hold, not division
    // by zero. Disabling crusher must restore the same canonical pipeline.
    assert!(wasm.process(&[],0,&[
        ParamEvent{id:17,offset:0,value:0.0}])?.is_empty());
    native.set_crusher(6,0)?;
    let frozen_input=frame_input((BLOCKS+3)*F,F);
    let frozen_pcm=wasm.process(&frozen_input,F,&[])?;
    let mut native_frozen=vec![0f32;2*F];
    native.process(&frozen_input,&mut native_frozen,F)?;
    assert!(frozen_pcm.iter().zip(native_frozen.iter()).all(|(a,b)|(a-b).abs()<0.008),
        "0Hz crusher freeze differs between native and WASM");
    assert!(wasm.process(&[],0,&[
        ParamEvent{id:11,offset:0,value:0.0}])?.is_empty());
    native.set_crusher(0,0)?;
    let disabled_input=frame_input((BLOCKS+4)*F,F);
    let disabled_pcm=wasm.process(&disabled_input,F,&[])?;
    let mut native_disabled=vec![0f32;2*F];
    native.process(&disabled_input,&mut native_disabled,F)?;
    assert!(disabled_pcm.iter().zip(native_disabled.iter()).all(|(a,b)|(a-b).abs()<0.008),
        "crusher off changed canonical Rust audio");
    // Reject invalid new geometry values without compromising DSP.
    assert!(wasm.process(&frame_input(16896,F),F,&[
        ParamEvent{id:8,offset:0,value:4.1}]).is_err());
    // Malformed physical crusher automation must be refused before the
    // interpreter, never reinterpreted as quantized/discrete host values.
    for invalid in [
        ParamEvent{id:11,offset:0,value:0.5},
        ParamEvent{id:16,offset:0,value:1.0},
        ParamEvent{id:16,offset:0,value:8.5},
        ParamEvent{id:17,offset:0,value:48001.0},
        ParamEvent{id:17,offset:0,value:-1.0},
    ] {
        assert!(wasm.process(&frame_input(17024,F),F,&[invalid]).is_err(),
            "invalid crusher physical event reached shared Rust Stream");
        assert!(!wasm.faulted(),
            "rejected noncanonical host event must not fault the valid engine");
    }
    for invalid in [
        ParamEvent{id:27,offset:0,value:0.0},
        ParamEvent{id:28,offset:0,value:1.01},
        ParamEvent{id:29,offset:0,value:2.5},
        ParamEvent{id:29,offset:0,value:9.0},
        ParamEvent{id:30,offset:0,value:-0.1},
    ] {
        assert!(wasm.process(&frame_input(17536,F),F,&[invalid]).is_err(),
            "noncanonical Engine A event should be rejected");
        assert!(!wasm.faulted(),"invalid host event cannot fault the Stream");
    }
    // Unsupported host param (e.g. Gain ID64) MUST fail on actual Stream,
    // while demo Identity/Gain native regression still accepts ID64.
    let buf=frame_input(16384,F);
    assert!(wasm.process(&buf,F,&[ParamEvent{id:64,offset:0,value:0.5}]).is_err());
    println!("PASS S4b4a native/WASM Stream: 16K PCM + Engine A four controls at sample20, parity max_error={biggest:.7}, crusher_diff={crusher_diff:.4}, engine_a_diff={engine_a_diff:.4}, latency=1023");
    Ok(())
}
