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

/// Only a real finite-band Fold L/H branch or a signed crossing of 0 Hz
/// is a reflection. A decreasing output curve by itself is *inversion*, not
/// a folded component (Reciprocal and physical negative slope are examples).
pub fn distance(f:f64,signed_target:f64,s:Settings,rational:bool,
    pitch:f64,delta:f64,anchor:f64,pivot:f64,slope:f64,
    reference:f64,shift:f64)->f64{
    let zero_crossing=(-signed_target).max(0.0);
    if !(f>=s.low&&f<=s.high) || s.invert<=0.0 {
        return zero_crossing;
    }
    let hinge=match s.mode {
        Progression::FoldHigh | Progression::FoldLow => fold_frequency(s),
        Progression::Reciprocal | Progression::Blend => None
    };
    let Some(hinge)=hinge else{return zero_crossing;};
    // The reflected side is intrinsic to the source-domain Fold mode.
    // Multiplying by a negative physical slope must NOT create or remove
    // a Fold event merely by changing the sign of the final derivative.
    let reflected=match s.mode {
        Progression::FoldHigh => f>hinge,
        Progression::FoldLow => f<hinge,
        _=>false
    };
    if !reflected{return zero_crossing;}
    let signed_hinge=match mapped_target(hinge,s,rational,pitch,delta,
        anchor,pivot,slope,reference,shift){
        Some(x)=>x,
        None=>return zero_crossing
    };
    // Measure only actual travel away from the hinge in the final physical
    // coordinate, and accumulate an additional 0-Hz crossing once.
    zero_crossing+(signed_target-signed_hinge).abs()
}
fn settings(low:f64,high:f64,p:f64,invert:f64,mode:u32)->Settings{
    Settings{low,high,curvature:p,invert,quality:0,mode:match mode{
        1=>Progression::Blend,2=>Progression::FoldLow,
        3=>Progression::Reciprocal,_=>Progression::FoldHigh}}
}

#[no_mangle]
pub extern "C" fn warp_all_reflection_distance(
    f:f64,output:f64,low:f64,high:f64,p:f64,invert:f64,mode:u32,
    rational:u32,pitch:f64,delta:f64,anchor:f64,pivot:f64,slope:f64,
    reference:f64,shift:f64)->f64{
    distance(f,output,settings(low,high,p,invert,mode),rational!=0,
        pitch,delta,anchor,pivot,slope,reference,shift)
}
#[no_mangle]
pub extern "C" fn warp_all_reflection_gain(
    f:f64,output:f64,low:f64,high:f64,p:f64,invert:f64,mode:u32,
    rational:u32,pitch:f64,delta:f64,anchor:f64,pivot:f64,slope:f64,
    reference:f64,shift:f64,synthesis:f64,reflection:f64)->f64{
    let d=warp_all_reflection_distance(f,output,low,high,p,invert,mode,
        rational,pitch,delta,anchor,pivot,slope,reference,shift);
    gain(d,synthesis,reflection,reference)
}

#[cfg(test)]
mod tests{
 use super::*;
 #[test]fn inversion_without_fold_does_not_attenuate(){
  let ordinary=Settings{low:100.0,high:1000.0,curvature:1.0,invert:0.0,
      mode:Progression::Reciprocal,quality:0};
  for slope in [-2.0,-1.0,0.0,1.0,2.0]{
    let target=mapped_target(500.0,ordinary,false,1.0,0.0,
      350.0,350.0,slope,350.0,0.0).unwrap();
    if target>0.0{
      let d=distance(500.0,target,ordinary,false,1.0,0.0,
        350.0,350.0,slope,350.0,0.0);
      assert_eq!(d,0.0,"plain slope {slope} is not a folded branch");
      assert_eq!(gain(d,0.0,1.0,350.0),1.0);
    }
  }
  let inverse=Settings{invert:1.0,..ordinary};
  for slope in [-1.0,1.0]{
    let target=mapped_target(500.0,inverse,false,1.0,0.0,
      350.0,350.0,slope,350.0,0.0).unwrap();
    if target>=0.0{
      assert_eq!(distance(500.0,target,inverse,false,1.0,0.0,
        350.0,350.0,slope,350.0,0.0),0.0);
    }
  }
 }
 #[test]fn only_the_actual_fold_branch_is_reflected(){
  let neutral=Settings{low:100.0,high:1000.0,curvature:1.0,
      invert:0.5,mode:Progression::FoldHigh,quality:0};
  let hinge=fold_frequency(neutral).unwrap();
  for slope in [-1.0,1.0]{
    for (mode,reflected_f,forward_f) in [
      (Progression::FoldHigh,800.0,300.0),
      (Progression::FoldLow,300.0,800.0)
    ]{
      let s=Settings{mode,..neutral};
      let turn=fold_frequency(s).unwrap();
      let fwd=mapped_target(forward_f,s,false,1.0,0.0,
        350.0,350.0,slope,350.0,0.0).unwrap();
      if fwd>=0.0 {
        assert_eq!(distance(forward_f,fwd,s,false,1.0,0.0,
          350.0,350.0,slope,350.0,0.0),0.0,
          "forward branch should not be affected even with negative slope");
      }
      let target=mapped_target(reflected_f,s,false,1.0,0.0,
        350.0,350.0,slope,350.0,0.0).unwrap();
      let d=distance(reflected_f,target,s,false,1.0,0.0,
        350.0,350.0,slope,350.0,0.0);
      assert!(d>0.0,"Fold branch must be classified at {turn} / slope {slope}");
    }
  }
  assert!(hinge>100.0&&hinge<1000.0);
 }
 #[test]fn signed_zero_crossing_is_reflected_even_without_fold(){
  let s=Settings{low:100.0,high:1000.0,curvature:1.0,
    invert:0.0,mode:Progression::Reciprocal,quality:0};
  let d=distance(100.0,-40.0,s,false,1.0,0.0,350.0,350.0,1.0,350.0,0.0);
  assert_eq!(d,40.0);
  assert!((gain(d,0.75,0.0,350.0)-0.75).abs()<1e-9);
 }
 #[test]fn reflected_positive_fold(){
  let s=Settings{low:100.0,high:1000.0,curvature:1.0,
    invert:0.5,mode:Progression::FoldHigh,quality:0};
  let t=mapped_target(800.0,s,false,1.0,0.0,350.0,350.0,1.0,350.0,0.0).unwrap();
  assert!(t>0.0);
  let d=distance(800.0,t,s,false,1.0,0.0,350.0,350.0,1.0,350.0,0.0);
  assert!(d>100.0);
  assert!((gain(d,0.5,0.0,350.0)-0.5).abs()<1e-9);
 }
}
