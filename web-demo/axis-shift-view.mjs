/** Unit projection for Rust's coordinate displacement u ∈ [-2,2].
 * Do not label a nonlinear intermediate-p coordinate as constant Hz/pitch.
 * View conversions never mutate the canonical DSP coordinate by themselves.
 */
const within=(x,a,b)=>Number.isFinite(x)&&x>=a&&x<=b;
export const axisShiftUnits=p=>p===1?["coordinate","percent","hz"]:
  p===0?["coordinate","percent","ratio"]:["coordinate","percent"];
export function axisShiftView(u,unit,p,reference){
  if(!within(u,-2,2)||!axisShiftUnits(p).includes(unit))throw RangeError("invalid axis view");
  if(unit==="percent")return 25*(u+2);
  if(unit==="hz"){
    if(!(reference>0&&Number.isFinite(reference)))throw RangeError("invalid reference");
    return u*reference;
  }
  if(unit==="ratio")return Math.exp(u);
  return u;
}
export function axisShiftCanonical(v,unit,p,reference){
  if(!Number.isFinite(v)||!axisShiftUnits(p).includes(unit))throw RangeError("invalid axis input");
  if(unit==="percent")v=v/25-2;
  else if(unit==="hz"){
    if(!(reference>0&&Number.isFinite(reference)))throw RangeError("invalid reference");
    v/=reference;
  }else if(unit==="ratio"){
    if(v<=0)throw RangeError("ratio must be positive");
    v=Math.log(v);
  }
  if(!within(v,-2,2))throw RangeError("axis movement outside rail");
  return v;
}
