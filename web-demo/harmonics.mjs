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
/** UI-only pipeline topology; actual spectral mapping and axis geometry
 * are callbacks into compiled Rust/WASM, not duplicated JavaScript formulas.
 * Information about discarded targets is displayed rather than silently
 * plotting a curve where DSP cannot actually output a spectral component. */
export function mapAtFrequency(f,
  {low,high,curvature,invert,mode,outside,pitchRatio=1,shiftHz=0,
   carrierHz=0,zeroMode=0,zeroReflectGain=1,zeroReflectDecay=0,reflectionAmplitude=null,allReflectionGain=null,
   axisShift=0,axisReference=350,axisPivot=axisReference,
   axisSlope=1,ringEnabled=false,rationalEnabled=false,sampleRate=48000,qualityIndex=0},
  warp,translate=(f)=>f) {
  const inside=f>=low&&f<=high;
  if(!inside&&outside!=="pass")return {f,inside,outputs:[],reason:"帯域外を除去"};
  const base=inside?warp(f,low,high,curvature,invert,mode):f;
  if(!Number.isFinite(base))return {f,inside,outputs:[],reason:"写像不能"};
  let transformed=base;
  if(inside){
    if(rationalEnabled)transformed=pitchRatio*transformed+shiftHz;
    const pivotInside=axisPivot>=low&&axisPivot<=high;
    const pivotBase=pivotInside?warp(axisPivot,low,high,curvature,invert,mode):axisPivot;
    const sourceAnchor=pivotBase;
    // Rust stream.rs skips axis translation when the optional rational stage
    // already crossed zero; both engines then apply the signed zero policy.
    if(transformed>0)transformed=translate(transformed,axisPivot,curvature,axisShift,axisSlope,sourceAnchor);
  }
  if(!Number.isFinite(transformed))return {f,inside,outputs:[],reason:"座標計算不能"};
  const signed=transformed;
  const allGain=typeof allReflectionGain==="function"?
    allReflectionGain(f,signed,pivotBase):null;
  const reflected=typeof allGain==="object"&&allGain!==null?
    allGain.distance>0:transformed<0;
  let reflectionGain=allGain===null?1:allGain.gain;
  if(reflected){
    if(zeroMode===1)return {f,inside,outputs:[],reflected:true,reflectionGain:0,reason:"0Hz未満を除去"};
    const fftWindow=[1024,2048,4096][qualityIndex]||1024;
    if(zeroMode===2 && -transformed>=sampleRate/fftWindow)return {f,inside,outputs:[],reflected:true,reflectionGain:0,reason:"0Hz未満を減衰除去"};
    if(zeroMode===2)reflectionGain=Math.max(0,1+transformed/(sampleRate/fftWindow));
    if(allGain!==null&&zeroMode===0)reflectionGain=allGain.gain;
    else if(allGain===null)reflectionGain=typeof reflectionAmplitude==="function"?
      reflectionAmplitude(-transformed):
      zeroReflectGain*Math.pow(1-zeroReflectDecay,-transformed/axisReference);
    if(reflectionGain===0)return {f,inside,outputs:[],reflected:true,reflectionGain:0,reason:"負周波数の反射振幅0%（除去）"};
    transformed=-transformed;
  }
  if(allGain!==null&&reflectionGain<=0)return {f,inside,outputs:[],
    reflected:true,reflectionGain:0,reason:"反射成分の合成率0%"};
  if(transformed===0)return {f,inside,outputs:[],reason:"0Hzへ到達"};
  // Ring Mod is applied only to transformed source components in [L,H].
  // Outside Pass is mixed unchanged after the ringed in-band wet signal.
  const candidates=ringEnabled&&inside?
    [transformed+carrierHz,Math.abs(transformed-carrierHz)]:[transformed];
  const outputs=candidates.filter(y=>Number.isFinite(y)&&y>0&&y<sampleRate/2);
  return {f,inside,outputs,reflected,reflectionGain,
    reason:outputs.length?"": "再生周波数範囲外（0Hz／ナイキスト）",
    raw:transformed};
}
export function graphSegments(settings,warp,translate=(f)=>f,maxHz=DISPLAY_MAX,sampleAt=null){
  const values=[];
  const f0=DISPLAY_MIN,f1=maxHz;
  for(let i=0;i<=512;i++){
    const f=sampleAt?sampleAt(i/512):f0+(f1-f0)*i/512;
    const point=mapAtFrequency(f,settings,warp,translate);
    values.push({...point,outputs:point.outputs.map(y=>y>=f0&&y<=f1?y:undefined)});
  }
  return values;
}
