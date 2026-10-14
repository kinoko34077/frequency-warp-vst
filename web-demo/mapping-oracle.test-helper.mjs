/** Independent JS mathematical *test oracle* only. Never loaded by the
 * production UI or audio worker. The mapping implementation's authority is
 * core/src/lib.rs => warp_map_frequency in native/WASM. */
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
    !["fold-h","fold-l","blend","reciprocal"].includes(mode))throw new RangeError("Invalid preview domain");
  if(invert===0)return f;
  const x=coordinate(f,low,p),d=coordinate(high,low,p);
  if(mode==="blend")return (1-invert)*f+invert*inverseCoordinate(d-x,low,p);
  if(mode==="reciprocal"){
    const inverse=inverseCoordinate(d-x,low,p);
    return Math.exp((1-invert)*Math.log(f)+invert*Math.log(inverse));
  }
  const direction=mode==="fold-l"?-1:1;
  const z=((x+direction*invert*d)%(2*d)+(2*d))%(2*d);
  return Math.min(high,Math.max(low,inverseCoordinate(d-Math.abs(z-d),low,p)));
}
