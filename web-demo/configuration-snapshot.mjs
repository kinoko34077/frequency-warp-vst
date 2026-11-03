/** U4: immutable, codec-independent snapshots of ONE processing configuration.
 * Never store a DOM string, an AudioBuffer or the live AudioWorklet object.
 * App-specific adapters must supply exact canonical values from binding owners.
 */
import {validateHarmonicConfiguration} from "./harmonics-panel.mjs";

// These are global Settings-dialog controls, not independent A/B sound states.
// The L front-panel control is intentionally per-slot despite its Settings mirror.
export const SHARED_SETTINGS_AUDIO_KEYS=Object.freeze([
  "mode","outside","qualityIndex","hopDiv","engine",
  "aQuality","aBandBins","aReverb"
]);
export function effectiveComparisonAudio(saved,current){
  const merged={...saved};
  for(const key of SHARED_SETTINGS_AUDIO_KEYS)merged[key]=current[key];
  merged.aMinHz=merged.low;
  merged.sampleRate=current.sampleRate;
  return merged;
}
export function verifyComparisonAudio(actual,saved){
  for(const [key,value] of Object.entries(saved)){
    if(key==="sampleRate"||SHARED_SETTINGS_AUDIO_KEYS.includes(key))continue;
    const expected=key==="aMinHz"?saved.low:value;
    if(!Object.is(actual[key],expected))throw Error("復帰検証失敗: "+key);
  }
  if(!Object.is(actual.aMinHz,saved.low))throw Error("復帰検証失敗: aMinHz");
}

const numeric={
  low:[.001,20000],high:[.001,20000],curvature:[0,1],invert:[0,1],
  axisPivot:[0,20000],axisSlope:[-4,4],axisShift:[-2,2],
  wet:[0,1],zeroReflectGain:[0,1],zeroReflectDecay:[0,1],
  aReverb:[0,1],aBandBins:[1,8],
  aQuality:[0,100],crusherRateHz:[0,192000],crusherBits:[0,16],
  manualCrusherBits:[2,16]
};
const integers=new Set(["aBandBins","aQuality","crusherBits","manualCrusherBits"]);
const enumValues={
  mode:["reciprocal","blend","fold-l","fold-h"],
  outside:["pass","kill"],
  quality:["eco","standard","high"],
  overlap:["4","8"],
  engine:["0","1"],
  pivotLinkTarget:["F","H"],
  harmonicCount:["3","5","7","12","16","24","32"]
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
  if(c.values.low>=c.values.high)throw Error("Invalid L/H bounds");
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
  if(c.values.crusherBits!==0&&c.values.crusherBits<2)
    throw Error("Invalid crusher bit count");
  if(c.flags.crusherEnabled && c.values.crusherBits!==c.values.manualCrusherBits)
    throw Error("Inconsistent crusher enablement");
  if(!c.flags.crusherEnabled && c.values.crusherBits!==0)
    throw Error("Disabled crusher unexpectedly active");
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
  if(c.view!==undefined){
    const vr=c.view.virtualRoot;
    if(!vr||!["target","keep-spacing"].includes(vr.placement))throw Error("Invalid virtual root placement");
    for(const key of ["F","H"]){
      if(!Number.isFinite(vr.scopes?.[key])||vr.scopes[key]<1||
        !["hz","note","percent"].includes(vr.units?.[key])||
        typeof vr.snaps?.[key]!=="boolean")throw Error("Invalid virtual root view");
    }
  }
  if(!c.audio||typeof c.audio!=="object")throw Error("Missing audio snapshot");
  const a=c.audio,h=c.harmonic;
  if(Math.abs(a.axisReference-h.r*h.F)>Math.max(1e-8,Math.abs(h.r*h.F)*1e-12)||
    Math.abs(a.shiftHz-h.n*h.r*h.F/h.m)>Math.max(1e-8,Math.abs(a.shiftHz)*1e-12)||
    a.low!==c.values.low||a.high!==c.values.high||a.axisPivot!==c.values.axisPivot||
    a.axisSlope!==c.values.axisSlope||a.wet!==c.values.wet)
    throw Error("DSP/harmonic canonical mismatch");
  return c;
}
export function createSoundConfiguration({sourceToken,sampleRate,harmonic,values,selectors,flags,audio,view}){
  const canonicalValues={...values},canonicalAudio={...audio};
  // Older snapshots stored an independent A cutoff in values/audio. Drop the
  // former and migrate the ABI compatibility field to this slot's common L.
  delete canonicalValues.aMinHz;
  canonicalAudio.aMinHz=canonicalAudio.low;
  const c={version:1,sourceToken,sampleRate,
    harmonic:{...harmonic},values:canonicalValues,selectors:{...selectors},flags:{...flags},audio:canonicalAudio,
    ...(view?{view:{virtualRoot:{...view.virtualRoot,
      scopes:{...view.virtualRoot.scopes},units:{...view.virtualRoot.units},snaps:{...view.virtualRoot.snaps}},
      ...(view.interface?{interface:{...view.interface,units:{...view.interface.units},
        disclosures:[...view.interface.disclosures],graph:{...view.interface.graph},
        sine:{...view.interface.sine},
        ...(view.interface.snaps?{snaps:{...view.interface.snaps}}:{})}}:{})}}:{})};
  validateSoundConfiguration(c);
  for(const value of [c.harmonic,c.values,c.selectors,c.flags,c.audio])Object.freeze(value);
  if(c.view){
    for(const value of [c.view.virtualRoot.scopes,c.view.virtualRoot.units,c.view.virtualRoot.snaps])Object.freeze(value);
    Object.freeze(c.view.virtualRoot);
    if(c.view.interface){
      for(const node of [c.view.interface.units,c.view.interface.disclosures,
        c.view.interface.graph,c.view.interface.sine,
        ...(c.view.interface.snaps?[c.view.interface.snaps]:[])])Object.freeze(node);
      Object.freeze(c.view.interface);
    }
    Object.freeze(c.view);
  }
  return Object.freeze(c);
}
