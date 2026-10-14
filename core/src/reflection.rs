//! Reflection gain geometry shared by native audio and the WASM graph.
use super::{Settings,Progression,map_frequency,fold_frequency,
    warp_invert_reference_frequency,translate_frequency_anchored};
pub fn mapped_target(f:f64,s:Settings,rational:bool,pitch:f64,delta:f64,
    anchor:f64,pivot:f64,slope:f64,reference:f64,shift:f64)->Option<f64>{
    let base=map_frequency(f,s).ok()?;
    let staged=if rational{pitch*base+delta}else{base};
    let x=if staged<=0.0{staged}else{
        translate_frequency_anchored(staged,anchor,pivot,slope,reference,s.curvature,shift)
    };
    if x.is_finite(){Some(x)}else{None}
}
pub fn gain(distance:f64,synthesis:f64,reflection:f64,reference:f64)->f64{
    if !distance.is_finite()||distance<0.0||!(0.0..=1.0).contains(&synthesis)||
        !(0.0..=1.0).contains(&reflection)||reference<=0.0{return f64::NAN;}
    if distance==0.0{return 1.0;}
    if reflection>=1.0{return 0.0;}
    synthesis*(1.0-reflection).powf(distance/reference)
}
