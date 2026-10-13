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
export function graphSegments({low,high,curvature,invert,mode,outside,engine,pitchRatio,shiftHz,carrierHz},warp){
  const values=[];
  const f0=DISPLAY_MIN, f1=DISPLAY_MAX;
  for(let i=0;i<=512;i++){
    const f=f0+(f1-f0)*i/512,inside=f>=low&&f<=high;
    let outputs=[];
    if(engine===2){
      outputs=[f+carrierHz,Math.abs(f-carrierHz)];
    }else if(engine===3){
      outputs=inside?[Math.abs(pitchRatio*f+shiftHz)]:outside==="pass"?[f]:[];
    }else{
      outputs=inside?[warp(f,low,high,curvature,invert,mode)]:outside==="pass"?[f]:[];
    }
    values.push({f,inside,outputs:outputs.filter(y=>Number.isFinite(y)&&y>=f0&&y<=f1)});
  }
  return values;
}
