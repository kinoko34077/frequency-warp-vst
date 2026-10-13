/**
 * UI-only mathematical graph and Wet helper.
 * This module does NOT transform audio. The only audio engine is
 * core/src/lib.rs compiled as wasm (and native C ABI for plugin wrappers).
 * Retained local coordinate math is a visualization projection only.
 */
export const QUALITY = Object.freeze({
  eco: {fftSize:1024,hop:256},
  standard: {fftSize:2048,hop:256},
  high: {fftSize:4096,hop:512}
});
function coordinate(f,low,p){
  const z=Math.log(f/low);
  return p===0?z:Math.expm1(p*z)/p;
}
function inverseCoordinate(x,low,p){
  return low*Math.exp(p===0?x:Math.log1p(p*x)/p);
}
export function mapFrequency(f,low,high,p,invert,mode="fold-h"){
  if(!(low>0 && high>low && Number.isFinite(high))||
    !Number.isFinite(f)||f<low||f>high||
    !Number.isFinite(p)||p<0||p>1||
    !Number.isFinite(invert)||invert<0||invert>1||
    !["fold-h","fold-l","blend"].includes(mode))throw new RangeError("Invalid preview domain");
  if(invert===0)return f;
  const x=coordinate(f,low,p),d=coordinate(high,low,p);
  if(mode==="blend")return (1-invert)*f+invert*inverseCoordinate(d-x,low,p);
  const direction=mode==="fold-l"?-1:1;
  const z=((x+direction*invert*d)%(2*d)+(2*d))%(2*d);
  return Math.min(high,Math.max(low,inverseCoordinate(d-Math.abs(z-d),low,p)));
}
export function mixWet(dry,processed,wet){
  if(!Number.isFinite(wet)||wet<0||wet>1||dry.length!==processed.length)
    throw new RangeError("Invalid Wet or channel lengths");
  return Float32Array.from(dry,(x,i)=>(1-wet)*x+wet*processed[i]);
}
