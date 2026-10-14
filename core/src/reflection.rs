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

pub fn distance(f:f64,signed_target:f64,s:Settings,rational:bool,
    pitch:f64,delta:f64,anchor:f64,pivot:f64,slope:f64,
    reference:f64,shift:f64)->f64{
    let negative=(-signed_target).max(0.0);
    if !(f>=s.low&&f<=s.high)||slope==0.0||(s.invert==0.0&&slope>=0.0){return negative;}
    // Classify reflection in the FINAL physical mapping. Negative slope may
    // reverse an otherwise forward warp, or cancel a previous inversion.
    // Outside-band Pass never acquires this reflected amplitude.
    let epsilon=((s.high-s.low)*0.00001).max(0.001);
    let lower=(f-epsilon).max(s.low);
    let upper=(f+epsilon).min(s.high);
    if upper<=lower{return negative;}
    let fa=match mapped_target(lower,s,rational,pitch,delta,anchor,pivot,slope,reference,shift){
        Some(x)=>x,None=>return negative
    };
    let fb=match mapped_target(upper,s,rational,pitch,delta,anchor,pivot,slope,reference,shift){
        Some(x)=>x,None=>return negative
    };
    if fb>=fa-1e-9{return negative;}
    let wa=match map_frequency(lower,s){Ok(x)=>x,Err(_)=>return negative};
    let wb=match map_frequency(upper,s){Ok(x)=>x,Err(_)=>return negative};
    let mirror=if slope<0.0&&wb>=wa-1e-9{
        // Negative physical slope reflects around the configured pivot.
        // The pivot remains fixed for shift=0 even after nonlinear warp.
        translate_frequency_anchored(anchor,anchor,pivot,slope,reference,s.curvature,shift)
    }else{
        // Existing Fold L/H or reciprocal turning/reference point.
        let fold=fold_frequency(s).unwrap_or_else(||{
            warp_invert_reference_frequency(s.low,s.high,s.curvature,s.invert,3)
        });
        match mapped_target(fold,s,rational,pitch,delta,anchor,pivot,slope,reference,shift){
            Some(x)=>x,None=>return negative
        }
    };
    if !mirror.is_finite(){return negative;}
    negative+(signed_target-mirror).abs()
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
 #[test]fn negative_slope_reflects_around_pivot_and_double_reversal_is_forward(){
  let ordinary=Settings{low:100.0,high:1000.0,curvature:1.0,invert:0.0,
      mode:Progression::Reciprocal,quality:0};
  let target=200.0;
  let d=distance(500.0,target,ordinary,false,1.0,0.0,350.0,350.0,-1.0,350.0,0.0);
  assert!((d-150.0).abs()<1e-7,"negative slope distance {d}");
  assert!((gain(d,0.5,0.0,350.0)-0.5).abs()<1e-7);
  let forward=distance(500.0,500.0,ordinary,false,1.0,0.0,350.0,350.0,1.0,350.0,0.0);
  assert_eq!(forward,0.0);
  let inverse=Settings{invert:1.0,..ordinary};
  let neg_target=mapped_target(500.0,inverse,false,1.0,0.0,350.0,350.0,-1.0,350.0,0.0).unwrap();
  let double=distance(500.0,neg_target,inverse,false,1.0,0.0,350.0,350.0,-1.0,350.0,0.0);
  assert_eq!(double,(-neg_target).max(0.0),"two direction reversals must not count as a positive-fold");
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
