/** U4: immutable, codec-independent snapshots of ONE processing configuration.
 * Never store a DOM string, an AudioBuffer or the live AudioWorklet object.
 * App-specific adapters must supply exact canonical values from binding owners.
 */
import {validateHarmonicConfiguration} from "./harmonics-panel.mjs";

const numeric={
  low:[.001,20000],high:[.001,20000],curvature:[0,1],invert:[0,1],
  axisPivot:[0,20000],axisSlope:[-4,4],axisShift:[-2,2],
  wet:[0,1],zeroReflectGain:[0,1],zeroReflectDecay:[0,1],
  aMinHz:[.001,20000],aReverb:[0,1],aBandBins:[1,8],
  aQuality:[0,100],crusherRateHz:[0,192000],crusherBits:[0,16]
};
const integers=new Set(["aBandBins","aQuality","crusherBits"]);
const enumValues={
  mode:["reciprocal","blend","fold-l","fold-h"],
  outside:["pass","kill"],
  quality:["eco","standard","high"],
  overlap:["2","4","8","16"],
  engine:["0","1"],
  pivotLinkTarget:["F","H"]
};
const flags=["engineAuto","ringEnabled","rationalEnabled","crusherEnabled",
  "carrierLink","harmonicPivotLink","pivotFollowLow","rationalEnabledByLink"];
export function validateSoundConfiguration(c,{sourceToken,sampleRate}={}){
  if(!c||c.version!==1||!Number.isSafeInteger(c.sourceToken)||
    !Number.isFinite(c.sampleRate)||c.sampleRate<=0)
    throw Error("Invalid configuration version or source identity");
  if(sourceToken!==undefined&&c.sourceToken!==sourceToken)
    throw Error("Configuration belongs to another audio source");
  if(sampleRate!==undefined&&c.sampleRate!==sampleRate)
    throw Error("Configuration sample rate changed");
  validateHarmonicConfiguration(c.harmonic);
  for(const [key,[lo,hi]] of Object.entries(numeric)){
    const v=c.values?.[key];
    if(typeof v!=="number"||!Number.isFinite(v)||v<lo||v>hi||
      (integers.has(key)&&!Number.isInteger(v)))
      throw Error("Invalid canonical "+key);
  }
  if(c.values.low>c.values.high)throw Error("Invalid L/H bounds");
  if(c.values.crusherRateHz>c.sampleRate)
    throw Error("Crusher update rate exceeds sample rate");
  for(const [key,options] of Object.entries(enumValues)){
    if(!options.includes(c.selectors?.[key]))
      throw Error("Invalid selector "+key);
  }
  for(const key of flags){
    if(typeof c.flags?.[key]!=="boolean")
      throw Error("Invalid flag "+key);
  }
  if(c.flags.rationalEnabledByLink &&
    (!c.flags.harmonicPivotLink||!c.flags.rationalEnabled))
    throw Error("Inconsistent automatic rational link");
  if(c.flags.harmonicPivotLink){
    const {F,m,r}=c.harmonic;
    const P=c.selectors.pivotLinkTarget==="F"?F:r*F/m;
    if(!Number.isFinite(P)||Math.abs(P-c.values.axisPivot)>
      Math.max(1e-9,Math.abs(P)*1e-10))
      throw Error("Inconsistent F/H to physical P link");
  }
  if(c.flags.pivotFollowLow&&c.values.axisPivot>0&&
    c.values.axisPivot<c.values.low)
    throw Error("Pivot is below enabled lower bound");
  return c;
}
export function createSoundConfiguration({sourceToken,sampleRate,harmonic,values,selectors,flags}){
  const c={version:1,sourceToken,sampleRate,
    harmonic:{...harmonic},values:{...values},selectors:{...selectors},flags:{...flags}};
  validateSoundConfiguration(c);
  for(const value of [c.harmonic,c.values,c.selectors,c.flags])Object.freeze(value);
  return Object.freeze(c);
}
