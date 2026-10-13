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
  const H=F/m,delta=n*H,foldShift=q*F+H;
  const rows=Array.from({length:count},(_,i)=>{
    const k=i+1;
    return {k,input:k*F,pitch:r*k*F,translated:k*F+delta,
      pitchThenShift:r*k*F+delta,reflected:Math.abs(k*F-foldShift),
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
export function graphSegments({low,high,curvature,invert,mode,outside,engine,pitchRatio,shiftHz,carrierHz,zeroMode=0},warp){
  const values=[];
  const f0=DISPLAY_MIN, f1=DISPLAY_MAX;
  for(let i=0;i<=512;i++){
    const f=f0+(f1-f0)*i/512,inside=f>=low&&f<=high;
    let outputs=[];
    const base=inside?[warp(f,low,high,curvature,invert,mode)]
      :outside==="pass"?[f]:[];
    if(engine===2){
      // Same order as Rust Stream::process: nonlinear warp, then Ring.
      outputs=base.flatMap(v=>[v+carrierHz,Math.abs(v-carrierHz)]);
    }else if(engine===3){
      // Pitch and signed-Hz are applied to in-band warped partials;
      // outside Pass is reconstructed unchanged by the Rust core.
      outputs=inside?base.flatMap(v=>{
        const target=pitchRatio*v+shiftHz;
        return target>=0?[target]:settingsZeroMode(zeroMode,target);
      }):base;
    }else{outputs=base;}
    values.push({f,inside,outputs:outputs.filter(y=>Number.isFinite(y)&&y>=f0&&y<=f1)});
  }
  return values;
}
