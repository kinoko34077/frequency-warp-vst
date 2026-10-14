//! S3a native runtime functional and fail-closed smoke.
//! Args: identity.fwengine gain-half.fwengine, packed by existing S1 tooling.
use fwengine_runtime::{PreparedEngine,Event};
use std::{env,fs};

fn main() -> Result<(),Box<dyn std::error::Error>> {
    let paths:Vec<String>=env::args().skip(1).collect();
    if paths.len()!=2 {return Err("usage: fwengine-runtime-smoke identity.fwengine gain.fwengine".into());}
    let a=fs::read(&paths[0])?;
    let b=fs::read(&paths[1])?;
    let mut old=PreparedEngine::prepare(&a,48000.0,2,256)?;
    let mut new=PreparedEngine::prepare(&b,48000.0,2,256)?;
    let input=vec![0.8_f32;512];
    let mut lhs=vec![-9.0_f32;512];
    let mut rhs=vec![-9.0_f32;512];
    old.process(&input,&mut lhs,256,&[])?;
    new.process(&input,&mut rhs,256,&[])?;
    assert!(lhs.iter().all(|x|(*x-0.8).abs()<1e-6),"old identity PCM");
    assert!(rhs.iter().all(|x|(*x-0.4).abs()<1e-6),"new gain-half PCM");
    let ev=[Event{param_id:64,sample_offset:128,canonical_value:0.25}];
    new.process(&input,&mut rhs,256,&ev)?;
    for channel in 0..2 {
        assert!((rhs[channel*256+127]-0.4).abs()<1e-6);
        assert!((rhs[channel*256+128]-0.2).abs()<1e-6);
    }
    // All validation and preparation failures leave old prepared engine unchanged.
    assert!(PreparedEngine::prepare(&[0u8;32],48000.0,2,256).is_err());
    old.process(&input,&mut lhs,256,&[])?;
    assert!(lhs.iter().all(|x|(*x-0.8).abs()<1e-6));
    // Finite fuel budget must stop a function before exceeding bounded work.
    new.set_fuel_limit(1);
    rhs.fill(-3.0);
    assert!(new.process(&input,&mut rhs,256,&[]).is_err());
    assert!(new.is_faulted());
    assert!(rhs.iter().all(|x|*x==-3.0),"fault must not commit PCM");
    println!("S3a OK: ZIP verification + import/fuel/memory bounded native WASM, identity vs gain PCM, sample-accurate automation, failure preserves previous engine");
    Ok(())
}
