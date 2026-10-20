/** Virtual-root workbench: original #16/#24 mathematics, independent of
 * the legacy harmonic panel's physical P slider or audio-support clamping.
 * This file is pure/read-only. Never claim that a plotted partial was heard.
 */
const integer=(v,min,max,name)=>{
  if(!Number.isSafeInteger(v)||v<min||v>max)throw RangeError(name+" out of range");
  return v;
};
const positive=(v,name)=>{
  if(typeof v!=="number"||!Number.isFinite(v)||v<=0)
    throw RangeError(name+" must be a positive finite frequency");
  return v;
};
function frequency(x,name){
  if(!Number.isFinite(x)||x<=0)throw RangeError(name+" is not representable");
  return x;
}
export function createVirtualRootPlan({
  F=350,H=87.5,m=4,h1=1,q=1,mode="series",placement="target",count=8
}={}){
  positive(F,"source fundamental F");
  integer(m,1,64,"harmonic index step m");
  integer(q,1,32,"fold source partial q");
  integer(h1,1,129,"first occupied index h1");
  integer(count,1,32,"partial count");
  if(!["series","fold-to-root"].includes(mode))throw RangeError("unknown series mode");
  if(!["target","keep-spacing"].includes(placement))throw RangeError("unknown pitch placement");
  // A fixed input spacing forces F'=F and therefore H=F/m. Arbitrary
  // H and preserved spacing cannot be independently demanded at fixed m.
  if(placement==="target")positive(H,"desired virtual fundamental H");
  const root=frequency(placement==="keep-spacing"?F/m:H,"virtual fundamental H");
  const pitched=frequency(m*root,"pitched fundamental F'");
  const ratio=pitched/F;
  if(!Number.isFinite(ratio)||ratio<=0)throw RangeError("pitch multiplier overflow");
  const numerator=mode==="series"?h1-m:-(q*m+1);
  const shift=numerator*root;
  if(!Number.isFinite(shift))throw RangeError("frequency shift overflow");
  const outputs=[];
  for(let k=1;k<=count;k++){
    const before=(m*k+numerator)*root;
    if(!Number.isFinite(before))throw RangeError("partial overflow");
    outputs.push(Object.freeze({
      k,source:k*F,pitched:k*pitched,signed:before,
      output:mode==="fold-to-root"?Math.abs(before):before,
      gridIndex:mode==="fold-to-root"?Math.abs(m*k+numerator):m*k+numerator,
      reflected:mode==="fold-to-root"&&before<0,
      atRoot:mode==="fold-to-root"?k===q:mode==="series"&&k===1&&h1===1
    }));
  }
  const notes=[];
  if(ratio<.25||ratio>4)notes.push("current DSP pitch ratio is limited to 0.25..4");
  if(Math.abs(shift)>20000)notes.push("current DSP shift is limited to +/-20,000 Hz");
  if(root<.001||root>20000)
    notes.push("theoretical H has no exact physical P coordinate in the current 0/.001..20kHz rail");
  if(F<.001||F>5_120_000)
    notes.push("source F is outside legacy input limits");
  // This is the rational stage's capability gate only. It is NOT an actual
  // AudioWorklet ACK; live stream bands, Nyquist, zero-mode and CPU may add gates.
  const rationalCapability=ratio>=.25&&ratio<=4&&Math.abs(shift)<=20000
    &&F>=.001&&F<=5_120_000;
  const representablePivot=root>=.001&&root<=20000;
  return Object.freeze({
    F,H:root,m,h1,q,mode,placement,pitched,ratio,numerator,shift,
    fraction:Object.freeze({n:numerator,m}),
    hasPhysicalRoot:mode==="fold-to-root"||h1===1,
    outputs:Object.freeze(outputs),
    capability:Object.freeze({
      rationalStage:rationalCapability,physicalPivot:representablePivot,
      theoryOnly:!rationalCapability,
      notes:Object.freeze(notes)
    })
  });
}
/** For user-facing detail only; numerator/denominator remain exact integer
 * values and are rendered by HTML <span> or MathML <mfrac> by the UI layer.
 */
export function virtualRootStatus(plan){
  if(!plan.capability.rationalStage)
    return "理論配置のみ：現行音声エンジンの入力範囲外。値は保持します。";
  if(!plan.capability.physicalPivot)
    return "倍音配置は計算可能。Pへの正確な連動は現行操作域外です。";
  return "理論配置を作成済み。実際の音声反映はDSPの受理・ACKを別途確認します。";
}
