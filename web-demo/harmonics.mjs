/**
 * Read-only theoretical visualization of Issue #16 mathematics.
 * These functions do NOT extract pitch, infer a chord, or process audio.
 * DSP processing is exclusively in Rust core/src/stream.rs.
 */
export const DISPLAY_MIN=20, DISPLAY_MAX=2000;
export function deriveHarmonics(F=350,m=4,n=-3,q=1,r=1,count=7){
  if(!(F>0&&F<=20000&&Number.isInteger(m)&&m>=1&&m<=64&&
       Number.isInteger(n)&&Math.abs(n)<=128&&Number.isInteger(q)&&q>=1&&q<=32&&
       r>0&&r<=4&&count>=1&&count<=32))throw RangeError("invalid harmonic inputs");
  const H=r*F/m,delta=n*H,foldShift=q*r*F+H;
  const rows=Array.from({length:count},(_,i)=>{
    const k=i+1;
    return {k,input:k*F,pitch:r*k*F,translated:r*k*F+delta,
      pitchThenShift:r*k*F+delta,reflected:Math.abs(r*k*F-foldShift),
      number:m*k+n};
  });
  return {F,m,n,q,r,H,delta,foldShift,rows};
}
function settingsZeroMode(mode,f){
  if(mode===0)return [Math.abs(f)];
  // Fade is a narrow phase-safe research placeholder: near zero, not an ideal analytic fold.
  if(mode===2&&f>-20)return [0];
  return [];
}
export function graphSegments({low,high,curvature,invert,mode,outside,pitchRatio=1,shiftHz=0,carrierHz=0,zeroMode=0,axisShift=0,axisReference=350,ringEnabled=false,rationalEnabled=false},warp,translate=(f)=>f){
  const values=[];
  const f0=DISPLAY_MIN, f1=DISPLAY_MAX;
  for(let i=0;i<=512;i++){
    const f=f0+(f1-f0)*i/512,inside=f>=low&&f<=high;
    let outputs=[];
    const base=inside?[warp(f,low,high,curvature,invert,mode)]
      :outside==="pass"?[f]:[];
    const shifted=inside?base.flatMap(v=>{
      const staged=rationalEnabled?pitchRatio*v+shiftHz:v;
      const target=staged>0?translate(staged,axisReference,curvature,axisShift):staged;
      return target>=0?[target]:settingsZeroMode(zeroMode,target);
    }):base;
    outputs=ringEnabled?shifted.flatMap(v=>[v+carrierHz,Math.abs(v-carrierHz)]):shifted;
    values.push({f,inside,outputs:outputs.filter(y=>Number.isFinite(y)&&y>=f0&&y<=f1)});
  }
  return values;
}
