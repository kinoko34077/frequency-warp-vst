import {QUALITY,mixWet} from "./dsp.mjs";
import {frequencyFromSlider,sliderFromFrequency,holdFromFrequency,drawCrusherPreview} from "./crusher-visual.mjs";
import {drawFrequencyGraph} from "./graph.mjs";
import {mountDualThumb} from "./dual-thumb.mjs";
import {switchAudioRoute} from "./audio-route.mjs";
import {engineForInbandCurve} from "./engine-policy.mjs";
import {canExportChannels} from "./export-policy.mjs";
import {freezeExportIdentity,matchesExportIdentity} from "./export-identity.mjs";
import {mapAtFrequency} from "./harmonics.mjs";
import {harmonicParameters,setFundamentalFromPivot,attachHarmonicPanel,renderHarmonicPanel,resolvedCarrierHz,resetHarmonicControls,captureHarmonicConfiguration,restoreHarmonicConfiguration} from "./harmonics-panel.mjs";
import {mountVirtualRootWorkbench} from "./virtual-root-workbench.mjs";
import {createSoundConfiguration,validateSoundConfiguration} from "./configuration-snapshot.mjs";
import {defineParameter,createParameterBinding} from "./parameter-binding.mjs";
import {mountFrequencyUnitField,mountParameterUnitField,mountPercentParameterField} from "./frequency-unit-field.mjs";
import {reconcileFrequencyBounds} from "./frequency-bounds.mjs";
import {prepareStreamSettings} from "./stream-parameter-contract.mjs";
import {createPlaybackFeedback} from "./playback-feedback.mjs";
import {auditionFeedbackView} from "./audition-feedback-view.mjs";
import {axisShiftUnits,axisShiftCanonical,axisShiftView} from "./axis-shift-view.mjs";

const $=id=>document.querySelector(id);
const MAX_PREVIEW_SECONDS=600;
let graphMax=2000;
let graphAlphaBeforeZoom=0;
const controls={
  dry:$("#play-dry"),wet:$("#play-wet"),stop:$("#stop"),
  render:$("#render"),download:$("#download")
};
const dualControls={};
let lowUnitControl=null,highUnitControl=null,pivotUnitControl=null,aMinUnitControl=null,sineUnitControl=null,slopeUnitControl=null;
// #79 M3: exactly one canonical Wet scalar; slider and typed % are views.
const wetBinding=createParameterBinding(defineParameter({
  id:"wet",min:0,max:1,defaultValue:1,units:["percent"],
  rail:{toPosition:value=>value,fromPosition:position=>position},digits:3
}));
const aReverbBinding=createParameterBinding(defineParameter({
  id:"a-reverb",min:0,max:1,defaultValue:0,units:["percent"],
  rail:{toPosition:value=>value,fromPosition:position=>position},digits:3
}));
// #79 M3 reflection synthesis gain: canonical fraction is independent of
// the whole-percent physical dual thumb and a precise typed %-value.
const zeroReflectBinding=createParameterBinding(defineParameter({
  id:"zero-reflect",min:0,max:1,defaultValue:1,units:["percent"],
  rail:{toPosition:value=>value,fromPosition:position=>position},digits:3
}));
// #79 M3 decay fraction: preserve full precision even with 1% dual thumb.
const zeroDecayBinding=createParameterBinding(defineParameter({
  id:"zero-decay",min:0,max:1,defaultValue:0,units:["percent"],
  rail:{toPosition:value=>value,fromPosition:position=>position},digits:3
}));
// #79 M3 shape inversion fraction: exact canonical and coarse .005 dual thumb.
const invertBinding=createParameterBinding(defineParameter({
  id:"invert",min:0,max:1,defaultValue:0,units:["percent"],
  rail:{toPosition:value=>value,fromPosition:position=>position},digits:3
}));
const state={
  ctx:null,decoded:null,dry:null,offline:null,offlineWorker:null,exportIdentity:null,sourceGeneration:0,
  module:null,workletLoaded:false,player:null,position:0,seek:0,
  qualityIndex:0,settingsRevision:0,name:"audio",fileMeta:"音声未選択",processing:false,
  precise:Object.create(null),
  effective:{low:20,high:16000},raf:0,lastStats:null,mathCore:null,wasmPromise:null,rebuildTimer:null,sine:null,loadToken:0,sourceGeneration:0,transportEpoch:0
};
// Continuous log bands around 20 Hz: 0..200 resolves 0.001..20 Hz,
// 200..1000 resolves 20..20,000 Hz. Exact typed values remain independent.
const MIN_POSITIVE_HZ=0.001;
const LOW_BREAK=200;
const hzFromScale=value=>{
  const x=clamp(Number(value),0,1000);
  return x<=LOW_BREAK?
    MIN_POSITIVE_HZ*Math.exp(Math.log(20/MIN_POSITIVE_HZ)*x/LOW_BREAK):
    20*Math.exp(Math.log(1000)*(x-LOW_BREAK)/(1000-LOW_BREAK));
};
// 0Hz is its own pivot position; the positive track covers 0.001Hz..20kHz
// with a smooth break at 20Hz to avoid losing sub-bass harmonic links.
const pivotFromScale=value=>{
  const x=clamp(Number(value),0,1000);
  if(x<=0)return 0;
  if(x<=200)return .001*Math.exp(Math.log(20000)*(x-1)/199);
  return 20*Math.exp(Math.log(1000)*(x-200)/800);
};
const scaleFromPivot=hz=>{
  if(hz<=0)return 0;
  if(hz<=20)return 1+Math.round(199*Math.log(Math.max(.001,hz)/.001)/Math.log(20000));
  return 200+Math.round(800*Math.log(Math.min(20000,hz)/20)/Math.log(1000));
};
const scaleFromHz=hz=>{
  const f=clamp(hz,MIN_POSITIVE_HZ,20000);
  return f<=20?
    Math.round(LOW_BREAK*Math.log(f/MIN_POSITIVE_HZ)/Math.log(20/MIN_POSITIVE_HZ)):
    Math.round(LOW_BREAK+(1000-LOW_BREAK)*Math.log(f/20)/Math.log(1000));
};
const hzText=hz=>hz>=1000?(hz/1000).toFixed(hz>=10000?1:2)+" kHz":hz<20?Number(hz.toFixed(3))+" Hz":Math.round(hz)+" Hz";
const clamp=(x,a,b)=>Math.max(a,Math.min(b,x));
const round3=value=>Math.round((value+Number.EPSILON)*1000)/1000;
const concise3=value=>Number.isFinite(value)?Number(value.toFixed(3)).toString():"—";
const displayDigits=()=>Number($("#decimal-digits")?.value||3);
const displayNumber=value=>Number(value.toFixed(displayDigits())).toString();
function refreshWetView(force=false){
  const field=$("#wet-value"),rail=$("#wet");
  const step=Number(rail.step)||.005;
  rail.value=String(Math.min(1,Math.max(0,Number((Math.round(wetBinding.value/step)*step).toFixed(9)))));
  field.dataset.fwCanonical=String(wetBinding.value);
  if(force||document.activeElement!==field)
    field.value=String(wetBinding.display(Math.min(3,displayDigits())));
}
function refreshAReverbView(force=false){
  const field=$("#a-reverb-value"),rail=$("#a-reverb");
  rail.value=String(Math.round(aReverbBinding.value*100));
  field.dataset.fwCanonical=String(aReverbBinding.value);
  if(force||document.activeElement!==field)
    field.value=String(aReverbBinding.display(Math.min(3,displayDigits())));
}
function refreshZeroReflectView(force=false){
  const field=$("#zero-reflect-value"),rail=$("#zero-reflect");
  rail.value=String(Math.round(zeroReflectBinding.value*100));
  field.dataset.fwCanonical=String(zeroReflectBinding.value);
  if(force||document.activeElement!==field)
    field.value=String(zeroReflectBinding.display(Math.min(3,displayDigits())));
}
function refreshZeroDecayView(force=false){
  const field=$("#zero-decay-value"),rail=$("#zero-decay");
  rail.value=String(Math.round(zeroDecayBinding.value*100));
  field.dataset.fwCanonical=String(zeroDecayBinding.value);
  if(force||document.activeElement!==field)
    field.value=String(zeroDecayBinding.display(Math.min(3,displayDigits())));
}
function refreshInvertView(force=false){
  const field=$("#invert-value"),rail=$("#invert"),step=Number(rail.step)||.005;
  rail.value=String(Math.min(1,Math.max(0,Number(
    (Math.round(invertBinding.value/step)*step).toFixed(9)))));
  field.dataset.fwCanonical=String(invertBinding.value);
  if(force||document.activeElement!==field)
    field.value=String(invertBinding.display(Math.min(3,displayDigits())));
}
const scalar=(name,fallback)=>name==="low"&&lowUnitControl?lowUnitControl.value:
  name==="high"&&highUnitControl?highUnitControl.value:
  name==="axis-pivot"&&pivotUnitControl?pivotUnitControl.value:
  name==="a-min"&&aMinUnitControl?aMinUnitControl.value:
  name==="axis-slope"&&slopeUnitControl?slopeUnitControl.value:
  name==="wet"?wetBinding.value:
  name==="a-reverb"?aReverbBinding.value:
  name==="zero-reflect"?zeroReflectBinding.value:
  name==="zero-decay"?zeroDecayBinding.value:
  name==="invert"?invertBinding.value:(state.precise[name]??fallback());
function refreshAxisShiftView(p,force=false){
  const unitSelector=$("#axis-shift-unit"),field=$("#axis-shift-value");
  const allowed=axisShiftUnits(p.curvature);
  for(const option of unitSelector.options)option.disabled=!allowed.includes(option.value);
  if(!allowed.includes(unitSelector.value))unitSelector.value="coordinate";
  const unit=unitSelector.value,ref=p.axisReference;
  const toView=u=>axisShiftView(u,unit,p.curvature,ref);
  const min=toView(-2),max=toView(2);
  field.min=String(min);field.max=String(max);field.step=unit==="coordinate"?"0.001":"any";
  if(force||document.activeElement!==field)field.value=String(Number(toView(p.axisShift).toFixed(displayDigits())));
  field.setAttribute("aria-label","移動量 "+unit+"（内部座標u="+concise3(p.axisShift)+"）");
}
function showNumber(id,value){
  const field=$("#"+id);
  if(id==="low-value"&&lowUnitControl){lowUnitControl.refresh();return;}
  if(id==="high-value"&&highUnitControl){highUnitControl.refresh();return;}
  if(id==="axis-pivot-value"&&pivotUnitControl){pivotUnitControl.refresh();return;}
  if(id==="a-min-value"&&aMinUnitControl){aMinUnitControl.refresh();return;}
  if(id==="axis-slope-value"&&slopeUnitControl){slopeUnitControl.refresh();return;}
  if(id==="sine-hz"&&sineUnitControl){sineUnitControl.refresh();return;}
  if(id==="wet-value"){refreshWetView();return;}
  if(id==="a-reverb-value"){refreshAReverbView();return;}
  if(id==="zero-reflect-value"){refreshZeroReflectView();return;}
  if(id==="zero-decay-value"){refreshZeroDecayView();return;}
  if(id==="invert-value"){refreshInvertView();return;}
  if(document.activeElement!==field&&Number.isFinite(value))field.value=displayNumber(value);
}
const fmtTime=seconds=>{
  const s=Math.max(0,seconds);
  return Math.floor(s/60)+":"+(s%60).toFixed(1).padStart(4,"0");
};
const duration=()=>state.dry?.length?state.dry[0].length/state.decoded.sampleRate:0;
function message(text,type="info"){
  const node=$("#status");
  if(node.textContent!==text)node.textContent=text;
  if(node.dataset.kind!==type)node.dataset.kind=type;
}
function syncAuditionFeedback(){
  const node=$("#harmonic-apply-evidence");
  if(!node)return;
  const wetMix=wetBinding.value;
  const view=auditionFeedbackView({
    loaded:Boolean(state.dry),player:state.player,wetMix
  });
  if(node.textContent!==view.text)node.textContent=view.text;
  if(node.dataset.phase!==view.phase)node.dataset.phase=view.phase;
  const f=state.player?.feedback?.current;
  // Diagnostic metadata is revision-specific; the visible cue intentionally
  // stays stable during rapid slider edits and never claims audible proof.
  node.title=f?"最新要求 #"+f.requestedRevision+" / DSP ACK #"+f.appliedRevision+
    (f.reason?" / "+f.reason:""):"理論グラフは音源の実測スペクトルではありません";
}
function indicator(text){
  const node=$("#rt-indicator");
  if(node.textContent!==text)node.textContent=text;
  syncAuditionFeedback();
}
function bounds(changed=""){
  const cap=state.decoded?Math.min(20000,state.decoded.sampleRate*.45):20000;
  // Reconcile physical Hz ONCE. Previously the computed peer correction was
  // overwritten by scalar() re-reading stale canonical binding values.
  const {low,high}=reconcileFrequencyBounds({
    low:scalar("low",()=>hzFromScale($("#low").value)),
    high:scalar("high",()=>hzFromScale($("#high").value)),
    cap,changed
  });
  if(lowUnitControl){
    if(!Object.is(lowUnitControl.value,low))lowUnitControl.setCanonical(low);
  }else $("#low").value=String(scaleFromHz(low));
  if(highUnitControl){
    if(!Object.is(highUnitControl.value,high))highUnitControl.setCanonical(high);
  }else $("#high").value=String(scaleFromHz(high));
  // Even with both exact values unchanged, refresh coarse handles/ARIA.
  state.effective={low,high};
  const min=$("#processing-min-hz");if(min&&document.activeElement!==min)min.value=String(low);
  showNumber("low-value",low);
  showNumber("high-value",high);
  const rail=$("#dual-range");
  rail.style.setProperty("--lo",($("#low").value/10)+"%");
  rail.style.setProperty("--hi",($("#high").value/10)+"%");
  dualControls.bounds?.sync();
  return state.effective;
}
const isHarmonicPivotLinked=()=>$("#harmonic-pivot-link").checked;
const pivotLinkTarget=()=>$("#pivot-link-target").value;
let rationalEnabledByLink=false;
function restoreRationalAfterUnlink(){
  if(rationalEnabledByLink)$("#rational-enabled").checked=false;
  rationalEnabledByLink=false;
}
function linkFeedback(reason=""){
  const note=$("#harmonic-pivot-link-note");
  note.hidden=!reason;
  note.textContent=reason;
}
function syncHarmonicToPivot(){
  const {F,m,r}=harmonicParameters(),target=pivotLinkTarget();
  const H=r*F/m;
  const pivot=target==="F"?F:H;
  if(!Number.isFinite(pivot)||pivot<0||(pivot>0&&pivot<.001)||pivot>20000){
    // Theoretical F may exceed the physical pivot rail; F belongs to the
    // harmonic controls, and must NEVER be rewritten to make P fit.
    $("#harmonic-pivot-link").checked=false;
    restoreRationalAfterUnlink();
    linkFeedback("連動解除："+(target==="F"?"元基音 F=":"仮想基音 H=")+concise3(pivot)+
      " Hz は物理起点Pの操作可能域（0Hz、または0.001〜20,000 Hz）の範囲外です。Fの値と起点Pは保持しました。");
    return scalar("axis-pivot",()=>pivotFromScale($("#axis-pivot").value));
  }
  linkFeedback("");
  if(pivotUnitControl){
    pivotUnitControl.setCanonical(pivot);
    return pivotUnitControl.value;
  }
  state.precise["axis-pivot"]=pivot;$("#axis-pivot").value=String(scaleFromPivot(pivot));
  return pivot;
}
function syncPivotToHarmonic(){
  const P=scalar("axis-pivot",()=>pivotFromScale($("#axis-pivot").value));
  const result=setFundamentalFromPivot(P,pivotLinkTarget());
  if(!result)return;
  if(pivotUnitControl)pivotUnitControl.setCanonical(result.pivot);
  else {state.precise["axis-pivot"]=result.pivot;$("#axis-pivot").value=String(scaleFromPivot(result.pivot));}
}
function settings(){
  const {low,high}=bounds();
  const qualityIndex=({eco:0,standard:1,high:2}[$("#quality").value]);
  const runtimeSampleRate=state.ctx?.sampleRate||state.decoded?.sampleRate||48000;
  const crusherRateHz=clamp(scalar("crusher-hold",()=>frequencyFromSlider($("#crusher-hold").value,runtimeSampleRate)),0,runtimeSampleRate);
  const harmonic=harmonicParameters();
  const value={
    low,high,curvature:scalar("curvature",()=>Number($("#curvature").value)),
    invert:scalar("invert",()=>Number($("#invert").value)),
    mode:$("#mode").value,outside:$("#outside").value,qualityIndex,
    engine:Number($("#engine").value),hopDiv:Number($("#overlap").value),
    pitchRatio:harmonic.r,
    shiftHz:harmonic.n*harmonic.r*harmonic.F/harmonic.m,
    carrierHz:harmonic.c,zeroMode:0,
    zeroReflectGain:scalar("zero-reflect",()=>Number($("#zero-reflect").value)/100),
    zeroReflectDecay:scalar("zero-decay",()=>Number($("#zero-decay").value)/100),
    axisShift:scalar("axis-shift",()=>Number($("#axis-shift").value)),
    axisReference:harmonic.r*harmonic.F,
    axisPivot:scalar("axis-pivot",()=>pivotFromScale($("#axis-pivot").value)),
    axisSlope:scalar("axis-slope",()=>Number($("#axis-slope").value)),
    sampleRate:runtimeSampleRate,
    wet:scalar("wet",()=>Number($("#wet").value)),
    ringEnabled:$("#ring-enabled").checked,
    rationalEnabled:$("#rational-enabled").checked,
    crusherBits:$("#crusher-enabled").checked?scalar("crusher-bits",()=>Number($("#crusher-bits").value)):0,
    crusherRateHz,
    crusherHold:holdFromFrequency(crusherRateHz,runtimeSampleRate),
    aMinHz:scalar("a-min",()=>hzFromScale($("#a-min").value)),
    aReverb:scalar("a-reverb",()=>Number($("#a-reverb").value)/100),
    aBandBins:Number($("#a-band").value),
    aQuality:Number($("#a-quality").value)
  };
  // Evaluate the effective curve that is drawn, not just the raw invert
  // mapping. Signed 0-Hz Reflect can reverse the displayed slope even when
  // Invert=0; the auto engine must agree with that change.
  if($("#engine-auto").checked && state.mathCore){
    // Ring sidebands are additional effects, not the base warp direction.
    // The green underlying transformed curve is the automatic A/B criterion.
    const coreCurve={...value,ringEnabled:false,
      allReflectionGain:allReflectionFor(value)};
    const {warp,translate}=mathCallbacksFor(coreCurve);
    value.engine=engineForInbandCurve(coreCurve,f=>
      mapAtFrequency(f,coreCurve,warp,translate).outputs[0]);
  }
  return value;
}

// U4 comparison: two bounded, source-scoped coherent configurations.
// A source generation changes ONLY after successful decode/commit.
const comparisonSlots={A:null,B:null};
let comparisonPending=null,comparisonCurrent=null,applyingConfiguration=false;
function comparisonMessage(text,phase="idle"){
  const node=$("#comparison-status");
  if(!node)return;
  if(node.textContent!==text)node.textContent=text;
  node.dataset.phase=phase;
}
function updateComparisonButtons(){
  for(const slot of ["A","B"]){
    $("#compare-save-"+slot.toLowerCase()).disabled=!state.dry;
    $("#compare-load-"+slot.toLowerCase()).disabled=!state.dry||!comparisonSlots[slot];
  }
}
function captureCurrentConfiguration(){
  const p=settings(),h=captureHarmonicConfiguration();
  const manualCrusherBits=state.precise["crusher-bits"]??Number($("#crusher-bits").value);
  return createSoundConfiguration({
    sourceToken:state.sourceGeneration,sampleRate:state.decoded.sampleRate,
    harmonic:h,audio:p,
    values:{
      low:p.low,high:p.high,curvature:p.curvature,invert:p.invert,
      axisPivot:p.axisPivot,axisSlope:p.axisSlope,axisShift:p.axisShift,
      wet:p.wet,zeroReflectGain:p.zeroReflectGain,zeroReflectDecay:p.zeroReflectDecay,
      aMinHz:p.aMinHz,aReverb:p.aReverb,aBandBins:p.aBandBins,aQuality:p.aQuality,
      crusherRateHz:p.crusherRateHz,crusherBits:p.crusherBits,manualCrusherBits
    },
    selectors:{
      mode:$("#mode").value,outside:$("#outside").value,quality:$("#quality").value,
      overlap:$("#overlap").value,engine:$("#engine").value,
      pivotLinkTarget:$("#pivot-link-target").value,harmonicCount:$("#harmonic-count").value
    },
    flags:{
      engineAuto:$("#engine-auto").checked,ringEnabled:$("#ring-enabled").checked,
      rationalEnabled:$("#rational-enabled").checked,crusherEnabled:$("#crusher-enabled").checked,
      carrierLink:$("#carrier-link").checked,harmonicPivotLink:$("#harmonic-pivot-link").checked,
      pivotFollowLow:$("#pivot-follow-low").checked,rationalEnabledByLink
    }
  });
}
function applyConfigurationSilently(c){
  // Preconditions are checked before entry. No DOM events or intermediate DSP
  // writes: the owning adapters accept exact canonical numbers first.
  const v=c.values,s=c.selectors,t=c.flags;
  for(const [id,value] of Object.entries({
    mode:s.mode,outside:s.outside,quality:s.quality,overlap:s.overlap,
    engine:s.engine,harmonicCount:s.harmonicCount,pivotLinkTarget:s.pivotLinkTarget
  })){
    const selectorId=id==="harmonicCount"?"harmonic-count":
      id==="pivotLinkTarget"?"pivot-link-target":id;
    $("#"+selectorId).value=value;
  }
  for(const [id,value] of Object.entries({
    "engine-auto":t.engineAuto,"ring-enabled":t.ringEnabled,
    "rational-enabled":t.rationalEnabled,"crusher-enabled":t.crusherEnabled,
    "carrier-link":t.carrierLink,"harmonic-pivot-link":t.harmonicPivotLink,
    "pivot-follow-low":t.pivotFollowLow
  }))$("#"+id).checked=value;
  rationalEnabledByLink=t.rationalEnabledByLink;
  lowUnitControl.setCanonical(v.low);highUnitControl.setCanonical(v.high);
  pivotUnitControl.setCanonical(v.axisPivot);slopeUnitControl.setCanonical(v.axisSlope);
  aMinUnitControl.setCanonical(v.aMinHz);
  restoreHarmonicConfiguration(c.harmonic);
  wetBinding.setCanonical(v.wet,{notify:false});
  aReverbBinding.setCanonical(v.aReverb,{notify:false});
  zeroReflectBinding.setCanonical(v.zeroReflectGain,{notify:false});
  zeroDecayBinding.setCanonical(v.zeroReflectDecay,{notify:false});
  invertBinding.setCanonical(v.invert,{notify:false});
  state.precise=Object.assign(Object.create(null),{
    curvature:v.curvature,
    "axis-shift":v.axisShift,
    "a-band":v.aBandBins,"a-quality":v.aQuality,
    "crusher-bits":v.manualCrusherBits,"crusher-hold":v.crusherRateHz
  });
  for(const [id,val] of Object.entries({
    curvature:v.curvature,
    "axis-shift":v.axisShift,
    "a-band":v.aBandBins,"a-quality":v.aQuality,
    "crusher-bits":v.manualCrusherBits,
    "crusher-hold":sliderFromFrequency(v.crusherRateHz,state.ctx?.sampleRate||state.decoded.sampleRate)
  }))$("#"+id).value=String(val);
  refreshWetView(true);
  refreshAReverbView(true);
  refreshZeroReflectView(true);
  refreshZeroDecayView(true);
  refreshInvertView(true);
  linkFeedback("");
}
function switchSoundConfiguration(slot){
  const saved=comparisonSlots[slot];
  if(!saved)return;
  try{
    validateSoundConfiguration(saved,{
      sourceToken:state.sourceGeneration,sampleRate:state.decoded.sampleRate
    });
    const preflight=prepareStreamSettings({
      ...saved.audio,sampleRate:state.ctx?.sampleRate||state.decoded.sampleRate
    });
    if(!preflight.ok)throw Error(preflight.message);
    const previous=captureCurrentConfiguration();
    // Every sound path is evaluated as a single transaction, with a local
    // rollback before the lone updateParams request if a mismatch is found.
    try{
      applyConfigurationSilently(saved);
      const actual=settings();
      for(const [key,value] of Object.entries(saved.audio)){
        if(key==="sampleRate")continue;
        if(!Object.is(actual[key],value))
          throw Error("復帰検証失敗: "+key);
      }
    }catch(error){
      applyConfigurationSilently(previous);
      throw error;
    }
    applyingConfiguration=true;
    try{
      updateParams("comparison");updateEngineInfo();tuneWet();
    }finally{applyingConfiguration=false;}
    document.dispatchEvent(new Event("fw:virtual-root-external-change"));
    comparisonCurrent=null;
    if(state.player&&!state.player.directDry&&state.player.mode==="wet"&&settings().wet>0){
      const f=state.player.feedback.current;
      comparisonPending={slot,revision:f.phase==="pending"?f.requestedRevision:null};
      comparisonMessage("設定"+slot+"：DSP反映確認中","pending");
    }else{
      comparisonPending=null;
      comparisonMessage("設定"+slot+"を復帰 · "+
        (state.player?"原音再生中（変換未確認）":"停止中（変換未確認）"),"ready");
    }
  }catch(error){
    comparisonMessage("切替不可："+error.message,"error");
  }
}
for(const slot of ["A","B"]){
  const key=slot.toLowerCase();
  $("#compare-save-"+key).addEventListener("click",()=>{
    if(!state.dry)return;
    try{
      comparisonSlots[slot]=captureCurrentConfiguration();
      updateComparisonButtons();
      comparisonMessage("設定"+slot+"を記録 · 別の設定を試してから復帰できます","saved");
    }catch(error){
      comparisonMessage("設定"+slot+"の記録失敗："+error.message,"error");
    }
  });
  $("#compare-load-"+key).addEventListener("click",()=>switchSoundConfiguration(slot));
}
function markComparisonEdited(){
  if(applyingConfiguration)return;
  if(comparisonPending||comparisonCurrent){
    comparisonPending=null;comparisonCurrent=null;
    comparisonMessage("設定を変更しました · 記録済みA/Bは保持","edited");
  }
}
function labels(id=""){
  bounds(id);
  const p=settings();
  showNumber("curvature-value",p.curvature);
  showNumber("axis-pivot-value",p.axisPivot);
  showNumber("axis-slope-value",p.axisSlope);
  showNumber("invert-value",100*p.invert);
  showNumber("zero-reflect-value",100*p.zeroReflectGain);
  showNumber("zero-decay-value",100*p.zeroReflectDecay);
  dualControls.reflection?.sync();
  dualControls.shape?.sync();
  $("#zero-reflect-status").textContent="合成 "+displayNumber(100*p.zeroReflectGain)+
    "% / 反射 "+displayNumber(100*p.zeroReflectDecay)+"%";
  // Trusted finite scalars only; mathematical notation is native MathML.
  $("#zero-reflect-formula").innerHTML='<math xmlns="http://www.w3.org/1998/Math/MathML"><mrow>'+
    '<mi>A</mi><mo>=</mo><mn>'+displayNumber(p.zeroReflectGain)+'</mn>'+
    '<msup><mrow><mo>(</mo><mn>1</mn><mo>−</mo><mn>'+displayNumber(p.zeroReflectDecay)+'</mn><mo>)</mo></mrow>'+
    '<mfrac><mi>d</mi><mrow><mn>'+displayNumber(p.axisReference)+'</mn><mi>Hz</mi></mrow></mfrac></msup>'+
    '</mrow></math> 折返し点からの距離 d に適用（単なる負の傾きは対象外）。';
  showNumber("wet-value",100*p.wet);
  refreshAxisShiftView(p);
  showNumber("a-min-value",p.aMinHz);
  showNumber("a-band-value",p.aBandBins);
  showNumber("a-quality-value",p.aQuality);
  const profile=[{count:6,floor:.09},{count:10,floor:.045},{count:18,floor:.025}][p.qualityIndex];
  const budget=profile.count+Math.floor(profile.count*3*p.aQuality/100);
  const floor=(profile.floor*(1-.9*p.aQuality/100)*100).toFixed(2);
  $("#a-quality-info").textContent="品質 "+p.aQuality+"/100 · 最大ピーク "+budget+"本/窓（基準 "+profile.count+"本）・候補閾値 "+floor+"%（窓内最大値比）。算術演算量の上限は基準の約 "+(budget/profile.count).toFixed(1)+"倍。実CPU時間は再生中のステータスへ表示。残差補完 "+p.aQuality+"%（実験）を適用。フォルマント・過渡の完全復元は未検証です。";
  showNumber("a-reverb-value",100*p.aReverb);
  showNumber("crusher-bits-value",p.crusherBits||Number($("#crusher-bits").value));
  $("#crusher-hold-value").max=String(p.sampleRate);
  showNumber("crusher-hold-value",p.crusherRateHz);
  $("#crusher-rate-explainer").textContent=p.crusherHold===0?
    "指定 0 Hz → 標本更新停止（最初の量子化値を保持・ゼロHz/DC）":
    "指定 "+displayNumber(p.crusherRateHz)+" Hz → 実効 "+displayNumber(p.sampleRate/p.crusherHold)+" Hz（"+p.crusherHold+"サンプル保持）"+(p.crusherBits?" · "+p.crusherBits+" bit 量子化":" · 加工OFF");
  const fxActive=p.crusherBits>0||p.ringEnabled;
  $("#fx-wave-preview").hidden=!fxActive;
  if(fxActive){
    $("#fx-wave-caption").textContent=p.ringEnabled&&p.crusherBits>0?
      "リング変調 → ビットクラッシャー（合成単音モデル）":
      p.ringEnabled?"リング変調：入力×搬送波（合成単音モデル）":
      "ビットクラッシャー：標本保持・量子化（合成単音モデル）";
    drawCrusherPreview($("#crusher-preview"),{
      bits:p.crusherBits,hold:p.crusherHold,sampleRate:p.sampleRate,
      ringEnabled:p.ringEnabled,carrierHz:resolvedCarrierHz(foldPoint)
    });
  }
  const u=p.axisShift,ref=p.axisReference;
  $("#axis-mode-hint").textContent=p.invert>0?"反転も適用中":"";
  const modeCode=p.mode==="blend"?1:p.mode==="fold-l"?2:p.mode==="reciprocal"?3:0;
  const hz=state.mathCore?.warp_invert_reference_frequency?.(p.low,p.high,p.curvature,p.invert,modeCode);
  $("#invert-reference-hz").textContent=p.mode==="blend"?"反転 "+displayNumber(p.invert*100)+"%":
    (p.mode==="reciprocal"?"反転固定点 ":p.mode==="fold-l"?"L折返し ":"H折返し ")+
    (Number.isFinite(hz)?displayNumber(hz)+" Hz":"—");
  const pText=displayNumber(p.curvature);
  $("#curvature-log-formula").innerHTML='<math xmlns="http://www.w3.org/1998/Math/MathML">'+
    '<mrow><mi>p</mi><mo>=</mo><mn>'+pText+'</mn><mo>;</mo>'+
    '<msub><mi>S</mi><mn>0</mn></msub><mo>(</mo><mi>f</mi><mo>)</mo><mo>=</mo>'+
    '<mi>ln</mi><mo>(</mo><mfrac><mi>f</mi><mi>L</mi></mfrac><mo>)</mo>'+
    '</mrow></math>'+
    '<math><mrow><msub><mi>S</mi><mi>p</mi></msub><mo>(</mo><mi>f</mi><mo>)</mo>'+
    '<mo>=</mo><mfrac><mrow><msup><mrow><mo>(</mo><mfrac><mi>f</mi><mi>L</mi></mfrac><mo>)</mo></mrow><mi>p</mi></msup><mo>−</mo><mn>1</mn></mrow><mi>p</mi></mfrac></mrow></math>';
  $("#axis-explainer").textContent=p.curvature===0?
    "移動倍率 ×"+displayNumber(Math.exp(u)):p.curvature===1?
    "移動 "+displayNumber(u*ref)+" Hz":"移動 "+displayNumber(u)+"（中間尺度）";
}

function foldPoint(){
  const core=state.mathCore;
  if(!core)return NaN;
  const p=settings();
  if(p.mode!=="fold-l"&&p.mode!=="fold-h")return NaN;
  return core.warp_fold_frequency(p.low,p.high,p.curvature,p.invert,
    p.mode==="fold-l"?2:0);
}
function axisMarker(f){
  const core=state.mathCore;
  if(!core||!(f>0))return NaN;
  const p=settings();
  const {warp,translate}=mathCallbacks();
  const result=mapAtFrequency(f,p,warp,translate);
  return result.raw??NaN;
}
function mathCallbacksFor(p){
  const core=state.mathCore,reference=p.axisReference;
  return {
    warp:(f,l,h,curvature,invert,mode)=>
      core.warp_map_frequency(f,l,h,curvature,invert,mode==="blend"?1:mode==="fold-l"?2:mode==="reciprocal"?3:0),
    translate:(f,pivot,curvature,shift,slope,anchor)=>
      core.warp_translate_frequency_anchored(f,anchor,pivot,slope,reference,curvature,shift)
  };
}
function allReflectionFor(p){
  const core=state.mathCore;
  const mode=p.mode==="blend"?1:p.mode==="fold-l"?2:p.mode==="reciprocal"?3:0;
  return (f,signed,anchor)=>{
    const args=[f,signed,p.low,p.high,p.curvature,p.invert,mode,
      p.rationalEnabled?1:0,p.pitchRatio,p.shiftHz,anchor,
      p.axisPivot,p.axisSlope,p.axisReference,p.axisShift];
    return {
      distance:core.warp_all_reflection_distance(...args),
      gain:core.warp_all_reflection_gain(...args,p.zeroReflectGain,p.zeroReflectDecay)
    };
  };
}
function mathCallbacks(){return mathCallbacksFor(settings());}
function updateListeningGuide(){
  if(!state.mathCore)return;
  const p=settings(),{warp,translate}=mathCallbacks();
  const pivot=Math.max(20,p.axisPivot);
  const input=500,point=mapAtFrequency(input,p,warp,translate);
  const output=point.outputs[0];
  const diff=Number.isFinite(output)?12*Math.log2(output/input):NaN;
  const hz=n=>Number.isFinite(n)?displayNumber(n)+"Hz":"—";
  const effect=Number.isFinite(diff)?(diff>=0?"+":"")+displayNumber(diff)+"半音":"範囲外";
  $("#listening-guide").textContent=point.outputs.length?
    "500Hz → "+hz(output)+"  ·  "+effect:"500Hz → "+point.reason;
  const warpPivot=warp(pivot,p.low,p.high,p.curvature,p.invert,p.mode);
  const details=[250,500,1000].map(f=>{
    const x=mapAtFrequency(f,p,warp,translate);
    return f+"Hz → "+(x.outputs.length?x.outputs.map(hz).join(" / "):x.reason);
  });
  // Mathematical descriptions and actual variables are rendered in
  // the separate semantic grid, not poured into a status paragraph.
}

function drawCurve(){
  const canvas=$("#curve");
  if(!state.mathCore){
    const width=Math.max(160,Math.round(canvas.getBoundingClientRect().width||260));
    canvas.width=width;canvas.height=width;return;
  }
  const p=settings();
  const shown={...p,carrierHz:resolvedCarrierHz(foldPoint),
    allReflectionGain:allReflectionFor(p)};
  const {warp,translate}=mathCallbacks();
  const alpha=Number($("#graph-log").value)/100;
  drawFrequencyGraph(canvas,shown,warp,translate,graphMax,alpha);
  let hasReflect=false;
  for(let i=0;i<=24;i++){
    const f=p.low+(p.high-p.low)*i/24;
    if(mapAtFrequency(f,shown,warp,translate).reflected){hasReflect=true;break;}
  }
  $("#reflection-activity").textContent=hasReflect?
    "反射区間あり · 2つのつまみは音声・グラフに即時反映":
    "現在は反射区間なし。反転や移動で反射が発生すると有効になります。";
  $("#graph-log-formula").innerHTML='<math xmlns="http://www.w3.org/1998/Math/MathML"><mrow>'+
    '<mi>α</mi><mo>=</mo><mn>'+displayNumber(alpha)+'</mn>'+
    '<mo>;</mo><mi>x</mi><mo>(</mo><mi>f</mi><mo>)</mo><mo>=</mo>'+
    '<mo>(</mo><mn>1</mn><mo>−</mo><mi>α</mi><mo>)</mo>'+
    '<mfrac><mi>f</mi><mi>M</mi></mfrac><mo>+</mo><mi>α</mi>'+
    '<msub><mi>g</mi><mtext>log</mtext></msub><mo>(</mo><mi>f</mi><mo>)</mo>'+
    '</mrow></math> M＝表示上限。低域拡大では 0.001Hz 起点の対数尺度。';
  const isCrushed=p.crusherBits>0&&(p.crusherHold>1||p.crusherHold===0);
  $("#crusher-alias-legend").hidden=!isCrushed;
  $("#crusher-alias-note").hidden=p.crusherBits===0;
  if(p.crusherBits>0)$("#crusher-alias-note").textContent=p.crusherHold===0?
    "更新 0 Hz：開始値を保持。出力はDCのみで元周波数の周期音は消えます。":
    (p.crusherHold===1?"間引き無し。振幅量子化による追加倍音は入力音の振幅・位相に依存します。":
    "実効更新 "+displayNumber(p.sampleRate/p.crusherHold)+" Hz。y="+displayNumber(p.sampleRate/p.crusherHold/2)+" Hzは実効ナイキスト折返し境界。実線＝単一正弦波の標本保持から生じる理論スペクトル像、透明度＝理想応答ゲイン（振幅量子化でさらに変化）。");
  updateListeningGuide();
  $("#graph-title").textContent=graphMax===20?"0.001〜20Hz":graphMax===2000?"〜2kHz":"〜20kHz";
}
async function ensureSharedCore(){
  if(!state.wasmPromise){
    state.wasmPromise=(async()=>{
      const response=await fetch("./dsp_core.wasm");
      if(!response.ok)throw Error("Rust/WASM "+response.status);
      const bytes=await response.arrayBuffer();
      const instance=new WebAssembly.Instance(new WebAssembly.Module(bytes),{});
      const core=instance.exports;
      if(typeof core.warp_fold_frequency!=="function"||
        typeof core.warp_map_frequency!=="function"||
        typeof core.warp_translate_frequency_anchored!=="function"||
        typeof core.warp_invert_reference_frequency!=="function"||
        typeof core.warp_zero_reflection_amplitude!=="function"||
        typeof core.warp_all_reflection_distance!=="function"||
        typeof core.warp_all_reflection_gain!=="function")throw Error("共通数式APIがありません");
      state.module=bytes;state.mathCore=core;
      labels(); // populate visible Rust/WASM fold/fixed-point Hz after async core boot
      drawCurve();renderHarmonicPanel(foldPoint,axisMarker,settings);
      if($("#engine-auto").checked){updateEngineInfo();updateParams("engine-auto");}
      return bytes;
    })().catch(error=>{
      state.wasmPromise=null;
      message("共通DSPの読み込みに失敗: "+error.message,"error");
      throw error;
    });
  }
  return state.wasmPromise;
}
function updateEngineInfo(){
  const s=settings(),q=QUALITY[$("#quality").value],rate=state.ctx?.sampleRate||48000;
  const latency=1000*(q.fftSize-1)/rate;
  const names=["A · 部分音再合成","B · STFT変換"];
  const explain=[
    "部分音追跡と発振器による実験的な再合成方式です。残差や過渡音は完全に復元されません。",
    "FFTビン再配置による実験的な再合成方式です。位相・離散格子誤差に注意してください。"
  ];
  const automatic=$("#engine-auto").checked;
  $("#engine").disabled=automatic;
  $("#engine").hidden=automatic;
  $("#engine-manual-label").hidden=automatic;
  $("#engine-auto-result").hidden=!automatic;
  $("#engine-auto-result").textContent="自動選択："+names[s.engine];
  $("#engine-a-settings").hidden=s.engine!==0;
  $("#engine-description").textContent=explain[s.engine]+
    (s.ringEnabled?" / Ring Mod ON":"")+(s.rationalEnabled?" / #24倍音配置 ON":"");
  $("#engine-summary").textContent=names[s.engine]+($("#engine-auto").checked?"（反転連動）":"");
  $("#engine-stats").textContent=
    "方式: "+names[s.engine]+" ｜FFT窓 "+q.fftSize+
    " ｜内部hop "+Math.round(q.fftSize/s.hopDiv)+
    " ｜理論DSP遅延 "+latency.toFixed(1)+"ms（"+Math.round(rate)+"Hz）"+
    " ｜AudioWorklet量子 128 samples（固定）";
}

function drawAudio(){
  const signal=state.dry?.[0];
  const canvas=$("#wave"),ratio=Math.min(devicePixelRatio||1,2);
  canvas.width=Math.max(240,Math.round(canvas.getBoundingClientRect().width*ratio));
  canvas.height=120*ratio;
  const ctx=canvas.getContext("2d");
  ctx.clearRect(0,0,canvas.width,canvas.height);
  if(!signal)return;
  ctx.strokeStyle="#4ed2b2";ctx.lineWidth=ratio;ctx.beginPath();
  for(let x=0;x<canvas.width;x++){
    const from=Math.floor(x*signal.length/canvas.width);
    const to=Math.max(from+1,Math.floor((x+1)*signal.length/canvas.width));
    let lo=1,hi=-1;
    for(let i=from;i<to;i++){lo=Math.min(lo,signal[i]);hi=Math.max(hi,signal[i]);}
    ctx.moveTo(x,(1-hi)*canvas.height/2);
    ctx.lineTo(x,(1-lo)*canvas.height/2);
  }
  ctx.stroke();
}
function playPosition(){
  if(!state.player||!state.ctx||!duration())return state.seek;
  return (state.player.offset+Math.max(0,state.ctx.currentTime-state.player.at))%duration();
}
function syncWaveSeekAccessibility(seconds){
  const wave=$("#wave"),pct=duration()?Math.round(clamp(seconds/duration(),0,1)*100):0;
  const value=String(pct),time=fmtTime(Math.floor(seconds));
  if(wave.getAttribute("aria-valuenow")!==value)wave.setAttribute("aria-valuenow",value);
  if(wave.getAttribute("aria-valuetext")!==time)wave.setAttribute("aria-valuetext",time);
}
function refreshPlayhead(){
  const seconds=playPosition();
  $("#elapsed").textContent=fmtTime(seconds);
  $("#duration").textContent=fmtTime(duration());
  $("#playhead").style.left=(duration()?clamp(seconds/duration(),0,1)*100:0)+"%";
  syncWaveSeekAccessibility(seconds);
  state.raf=requestAnimationFrame(refreshPlayhead);
}
function playheadFromPointer(e){
  if(!state.dry)return;
  const rect=$("#wave").getBoundingClientRect();
  const frac=clamp((e.clientX-rect.left)/rect.width,0,.999999);
  state.seek=frac*duration();
  // Choosing a timeline position must not silently choose Wet playback.
  // Leave the source stopped until an explicit Original or Processed action.
  if(state.player)seek(state.seek);
  refreshStatusSeek();
}
function refreshStatusSeek(){
  $("#elapsed").textContent=fmtTime(state.seek);
  $("#playhead").style.left=(duration()?100*state.seek/duration():0)+"%";
  syncWaveSeekAccessibility(state.seek);
}
$("#wave").addEventListener("pointerdown",playheadFromPointer);
$("#wave").addEventListener("keydown",event=>{
  if(!state.dry)return;
  const key=event.key;
  const arrows=["ArrowLeft","ArrowRight","ArrowUp","ArrowDown"];
  if(!arrows.includes(key)&&key!=="Home"&&key!=="End")return;
  event.preventDefault();
  const delta=key==="ArrowLeft"||key==="ArrowDown"?-2:2;
  const pos=key==="Home"?0:key==="End"?Math.max(0,duration()-.01)
    :clamp(playPosition()+delta,0,Math.max(0,duration()-.01));
  state.seek=pos;
  if(state.player)seek(pos);
  refreshStatusSeek();
});
async function context(){
  try{if(navigator.audioSession)navigator.audioSession.type="playback";}catch{}
  if(!state.ctx)state.ctx=new AudioContext();
  await state.ctx.resume();return state.ctx;
}
async function prepareCore(){
  const ctx=await context();
  if(!state.workletLoaded){
    await ctx.audioWorklet.addModule("./realtime.worklet.js");
    state.workletLoaded=true;
  }
  if(!state.module)await ensureSharedCore();
  return {ctx,module:state.module};
}
function makeBuffer(){
  const ctx=state.ctx;
  const audio=ctx.createBuffer(state.dry.length,state.dry[0].length,state.decoded.sampleRate);
  state.dry.forEach((ch,i)=>audio.copyToChannel(ch,i));
  return audio;
}
function tuneWet(){
  const p=state.player;
  // A direct original-audio transport must never derive its level from DSP.
  if(!p||p.directDry)return;
  const now=state.ctx.currentTime,wet=p.mode==="wet"?settings().wet:0;
  p.wet.gain.setTargetAtTime(wet,now,.012);
  p.dry.gain.setTargetAtTime(1-wet,now,.012);
}
function playerMessage(node,p){
  return ({data})=>{
    if(state.player!==p)return;
    if(data.type==="error"){
      if(p.feedback.fail(data.revision,data.message)){
        indicator("DSP設定反映失敗"+(data.revision!==undefined?" · "+data.revision:""));
        message("共通DSP: "+data.message,"error");
        if(comparisonPending){
          comparisonMessage("設定"+comparisonPending.slot+"のDSP反映失敗 · 保存値は保持","error");
          comparisonPending=null;comparisonCurrent=null;
        }
      }
      if(data.fatal&&!p.fatalDryRecovery){
        // The Worklet discarded an untrustworthy partially-mutated stream.
        // Always preserve the loaded original when no DSP recovery is safe.
        p.fatalDryRecovery=true;
        const where=playPosition();
        void (async()=>{
          if(state.player!==p)return;
          await stop();
          if(state.player)return;
          await play("dry",where);
          if(state.player?.directDry){
            indicator("変換復旧失敗 · 原音再生中");
            message("変換の復旧に失敗したため、原音再生へ退避しました。"+data.message,"error");
          }
        })();
      }
    }
    if(data.type==="parameters-applied"){
      if(p.feedback.ack(data.revision)){
        p.appliedRevision=data.revision;
        // Keep nonvisual ACK evidence for host regression tests; the text is
        // stable after the first successful update, never toggled to
        // "updating..." for each slider tick.
        $("#rt-indicator").dataset.appliedRevision=String(data.revision);
        indicator("稼働中 · Rust/WASM 128 samples/block · 操作反映済み");
        if(comparisonPending?.revision===data.revision){
          comparisonCurrent=comparisonPending.slot;
          comparisonMessage("設定"+comparisonCurrent+"：DSP最新設定の受理を確認","applied");
          comparisonPending=null;
        }
      }
    }
    if(data.type==="stats"){
      state.lastStats=data;
      const wet=Number(data.outputRms)||0,dry=Number(data.inputRms)||0;
      $("#signal-diagnostic").textContent=dry>.002&&wet<dry*.01?
        "⚠ 変換音が小さい":wet>0.003?"変換音：出力中":"再生中";
      $("#signal-diagnostic").title="DSP処理の直近 "+Number(data.windowSeconds||0).toFixed(2)+" 秒｜入力 "+dry.toFixed(3)+" / 変換 "+wet.toFixed(3)+" RMS";
      $("#signal-diagnostic").dataset.silent=dry>.002&&wet<dry*.01?"yes":"no";
      const latency=1000*data.latencyFrames/state.ctx.sampleRate;
      // Periodic telemetry is passive: it must not overwrite pending,
      // rejected or failed audio-parameter feedback (A14).
      $("#rt-telemetry").textContent="DSP遅延 "+latency.toFixed(1)+" ms · 約 "+
        data.averageBlockMs.toFixed(2)+" ms/block / 予算超過 "+data.overBudgetBlocks;
    }
  };
}
function startSource(p,offset){
  if(p.source){try{p.source.stop();}catch{}p.source.disconnect();}
  if(p.worklet)p.worklet.port.postMessage({type:"reset"});
  const src=state.ctx.createBufferSource();
  src.buffer=p.buffer;src.loop=true;src.connect(p.worklet||p.dry);
  const when=state.ctx.currentTime+.025;
  src.start(when,clamp(offset,0,Math.max(0,duration()-.001)));
  p.source=src;p.offset=offset;p.at=when;state.seek=offset;
}
function seek(seconds){
  const p=state.player;
  const where=clamp(seconds,0,Math.max(0,duration()-.001));
  state.seek=where;mediaStatus(Boolean(p));
  if(!p)return;
  // Short host mute covers state reset and rebuffering at the new position.
  const now=state.ctx.currentTime;
  p.master.gain.cancelScheduledValues(now);
  p.master.gain.setTargetAtTime(0,now,.008);
  startSource(p,where);
  p.master.gain.setTargetAtTime(1,now+.040,.02);
  message("波形位置 "+fmtTime(where)+" から再生します。","info");
}
function mediaStatus(playing){
  const session=navigator.mediaSession;
  if(!session)return;
  try{
    if(typeof MediaMetadata==="function")session.metadata=new MediaMetadata({title:state.name||"Frequency Warp"});
    session.playbackState=playing?"playing":"paused";
  }catch{}
}
function installMediaControls(){
  const session=navigator.mediaSession;
  if(!session?.setActionHandler)return;
  for(const [name,fn] of [
    ["play",()=>play(state.player?.mode||"wet",state.seek)],
    ["pause",()=>stop()],
    ["stop",()=>stop()],
    ["seekto",event=>seek(event.seekTime||0)]
  ])try{session.setActionHandler(name,fn);}catch{}
}
installMediaControls();
async function mediaBridge(player){
  const element=$("#background-output");
  if(!element||!state.ctx?.createMediaStreamDestination)return;
  let node;
  try{
    node=state.ctx.createMediaStreamDestination();
    player.bridgeRoute=state.ctx.createGain();
    player.bridgeRoute.gain.value=0.0001;
    player.master.connect(player.bridgeRoute);
    player.bridgeRoute.connect(node);
    element.srcObject=node.stream;
    const fallback=()=>{if(state.player===player)switchAudioRoute(player,state.ctx,false);};
    // An external iOS lock-screen / headset pause is a transport pause, not
    // a route failure. Rerouting a looping BufferSource here kept playing.
    element.onpause=()=>{
      if(state.player!==player||player.bridgeInternalPause)return;
      // Browser audio elements can pause spontaneously during output-route
      // negotiations. An unhidden element pause is NOT a user Pause command.
      // The installed MediaSession pause handler is the primary transport stop;
      // a hidden iOS document pause is its physical-control fallback.
      if(document.visibilityState==="hidden" ||
         navigator.mediaSession?.playbackState==="paused")void stop();
      else fallback();
    };
    element.onwaiting=fallback;
    element.onstalled=fallback;
    element.onerror=fallback;
    element.onplaying=()=>{
      if(state.player===player){
        player.bridgeInternalPause=false;
        switchAudioRoute(player,state.ctx,true);
      }
    };
    await element.play();
    if(state.player!==player){
      // stop/new play already owns the shared HTMLMediaElement. A delayed
      // old play() completion must not pause or clear the NEW media stream.
      try{player.bridgeRoute?.disconnect();}catch{}
      player.bridgeRoute=null;
      return;
    }
    if(!element.paused)switchAudioRoute(player,state.ctx,true);
    player.mediaBridge=node;
  }catch{
    switchAudioRoute(player,state.ctx,false);
    try{player.bridgeRoute?.disconnect();}catch{}
    player.bridgeRoute=null;
    // The rejected promise may belong to an obsolete player. Only its
    // CURRENT owner may mutate this shared element's media output.
    if(state.player===player){
      try{player.bridgeInternalPause=true;element.pause();element.srcObject=null;}catch{}
    }
  }
}
async function stop(){
  // Fence any pending async AudioContext/WASM/Worklet launch. A successful
  // file replacement and explicit stop must never be undone by an old click.
  state.transportEpoch++;
  if(state.rebuildTimer){clearTimeout(state.rebuildTimer);state.rebuildTimer=null;}
  const p=state.player;
  if(!p){
    controls.stop.disabled=true;mediaStatus(false);
    indicator("停止中");
    return;
  }
  state.seek=playPosition();
  state.player=null;
  try{p.source?.stop();}catch{}
  try{p.source?.disconnect();p.worklet?.disconnect();p.wet?.disconnect();
    p.dry.disconnect();p.master.disconnect();p.directRoute.disconnect();
    p.bridgeRoute?.disconnect();}catch{}
  try{p.worklet?.port.postMessage({type:"dispose"});}catch{}
  try{const el=$("#background-output");el.pause();el.srcObject=null;}catch{}
  mediaStatus(false);
  if(p.worklet)p.worklet.port.onmessage=null;
  controls.stop.disabled=true;
  $("#rt-telemetry").textContent="";
  indicator("停止中 · Rust / WASM AudioWorklet");
  refreshStatusSeek();
}
async function play(mode="wet",offset=null){
  if(!state.dry)return;
  if(state.player?.directDry&&mode==="wet"){
    // A rejected wet request must not destroy a currently audible original.
    const check=prepareStreamSettings(settings());
    if(!check.ok){
      indicator("原音再生中 · 変換設定未反映 · "+check.field);
      message("原音再生を継続中。変換設定は未反映: "+check.message,"error");
      return;
    }
    const position=offset===null?playPosition():offset;
    const nextEpoch=state.transportEpoch+1;
    await stop();
    if(state.transportEpoch!==nextEpoch)return;
    return play("wet",position);
  }
  if(state.player){
    if(offset!==null)seek(offset);
    state.player.mode=mode;
    tuneWet();
    message(mode==="wet"?"リアルタイム音声処理中。パラメータは即時適用されます。":"原音を連続再生中。");
    return;
  }
  const launchEpoch=++state.transportEpoch;
  controls.dry.disabled=true;controls.wet.disabled=true;
  if(mode==="dry"){
    indicator("原音を起動中…");
    try{
      // Browser native buffer playback; even a broken/unavailable wet WASM
      // engine or an invalid theoretical F cannot block original audition.
      const ctx=await context();
      if(launchEpoch!==state.transportEpoch)return;
      const dry=ctx.createGain(),master=ctx.createGain(),directRoute=ctx.createGain();
      dry.gain.value=1;master.gain.value=1;directRoute.gain.value=1;
      dry.connect(master);master.connect(directRoute);directRoute.connect(ctx.destination);
      const player={
        directDry:true,worklet:null,dry,wet:null,master,directRoute,
        bridgeRoute:null,outputRoute:"direct",buffer:makeBuffer(),
        source:null,mode:"dry",at:ctx.currentTime,offset:0
      };
      state.player=player;
      startSource(player,offset===null?state.seek:offset);
      mediaStatus(true);
      void mediaBridge(player);
      controls.stop.disabled=false;
      $("#rt-telemetry").textContent="";
      indicator("原音再生中 · 変換DSPから独立");
      message("原音再生中。変換設定にかかわらず音源を再生しています。");
    }catch(error){
      if(launchEpoch!==state.transportEpoch)return;
      await stop();
      message("原音再生準備失敗: "+error.message,"error");
      indicator("原音起動失敗");
    }finally{
      if(launchEpoch===state.transportEpoch){
        controls.dry.disabled=!state.dry;
        controls.wet.disabled=!state.dry;
      }
    }
    return;
  }
  indicator("共通Rust/WASM DSPの起動中…");
  try{
    const {ctx,module}=await prepareCore();
    if(launchEpoch!==state.transportEpoch)return;
    const preflight=prepareStreamSettings(settings());
    if(!preflight.ok)throw Error("設定が現行DSPに非対応: "+preflight.message);
    const current=preflight.settings;
    const worklet=new AudioWorkletNode(ctx,"frequency-warp-rust",{
      numberOfInputs:1,numberOfOutputs:2,
      outputChannelCount:[state.dry.length,state.dry.length]
    });
    const dry=ctx.createGain(),wet=ctx.createGain(),master=ctx.createGain();
    worklet.connect(wet,0);worklet.connect(dry,1);
    dry.connect(master);wet.connect(master);
    const directRoute=ctx.createGain();
    directRoute.gain.value=1;
    master.connect(directRoute);directRoute.connect(ctx.destination);
    master.gain.value=1;
    const player={
      worklet,dry,wet,master,directRoute,bridgeRoute:null,outputRoute:"direct",
      buffer:makeBuffer(),source:null,
      mode,quality:current.qualityIndex,engine:current.engine,hopDiv:current.hopDiv,at:ctx.currentTime,
      offset:0,appliedRevision:0,feedback:createPlaybackFeedback(),
      notice:preflight.warnings.join(" ")
    };
    state.player=player;
    worklet.port.onmessage=playerMessage(worklet,player);
    worklet.addEventListener("processorerror",()=>message("AudioWorklet処理エラーが発生しました。再度再生してください。","error"));
    const ready=new Promise((resolve,reject)=>{
      const timeout=setTimeout(()=>reject(Error("AudioWorkletの起動が時間切れです。")),10000);
      const handler=worklet.port.onmessage;
      worklet.port.onmessage=event=>{
        if(event.data.type==="ready"){clearTimeout(timeout);worklet.port.onmessage=handler;resolve(event.data);}
        else if(event.data.type==="error"){clearTimeout(timeout);reject(Error(event.data.message));}
      };
    });
    // AudioWorklet may remain unscheduled without an active connected input.
    // Start the input before waiting for the processor's ready message.
    const start=offset===null?state.seek:offset;
    startSource(player,start);
    mediaStatus(true);
    void mediaBridge(player);
    worklet.port.postMessage({type:"init",bytes:module,channels:state.dry.length,settings:current});
    const result=await ready;
    if(state.player!==player||launchEpoch!==state.transportEpoch)return;
    player.feedback.ready();
    tuneWet();
    // Stream-format rebuild creates a new Worklet. Require a fresh revisioned
    // confirmation before reporting this restored slot as accepted.
    if(comparisonPending?.revision===null&&mode==="wet"){
      applyingConfiguration=true;
      try{updateParams("comparison-confirm");}
      finally{applyingConfiguration=false;}
      comparisonPending.revision=player.feedback.current.phase==="pending"?
        player.feedback.current.requestedRevision:null;
    }
    controls.stop.disabled=false;
    indicator("稼働中 · Rust/WASM AudioWorklet · "+(1000*result.latencyFrames/ctx.sampleRate).toFixed(1)+" ms DSP遅延");
    message(player.notice ||
      (mode==="wet"?"128サンプル単位でリアルタイム変換中。ツマミ操作で曲全体を再計算しません。":"原音再生中。"),
      player.notice?"warning":"info");
  }catch(error){
    if(launchEpoch!==state.transportEpoch)return;
    // DSP failure must not prevent listening to the already loaded source.
    // Retain the requested position and fall back to direct original audio.
    const resume=state.player?playPosition():(offset===null?state.seek:offset);
    await stop();
    await play("dry",resume);
    if(state.player?.directDry) {
      indicator("原音再生中 · 変換DSPは一時不使用");
      message("変換DSPは適用できませんでした。原音を継続再生します: "+
        error.message,"warning");
    }else{
      message("音声再生準備失敗: "+error.message,"error");
      indicator("起動失敗");
    }
  }finally{
    if(launchEpoch===state.transportEpoch){
      controls.dry.disabled=!state.dry;
      controls.wet.disabled=!state.dry;
    }
  }
}
function updateParams(changed){
  if(!applyingConfiguration && changed!=="comparison-confirm")markComparisonEdited();
  // L is a cutoff; P is a coordinate anchor. Keep them independent unless
  // the user explicitly enabled a minimum bound for P, preserving P=0.
  if($("#pivot-follow-low").checked){
    const low=bounds(changed).low;
    const pivot=scalar("axis-pivot",()=>pivotFromScale($("#axis-pivot").value));
    if(pivot>0&&pivot<low){
      pivotUnitControl.setCanonical(low);
      if(isHarmonicPivotLinked())syncPivotToHarmonic();
    }
  }
  labels(changed);drawCurve();renderHarmonicPanel(foldPoint,axisMarker,settings);
  state.offline=null;state.exportIdentity=null;controls.download.disabled=true;
  // Export runs on a separate worker with a frozen parameter snapshot. Never
  // let a completed render from old controls be presented as current output.
  if(state.offlineWorker){
    state.offlineWorker.terminate();state.offlineWorker=null;
    controls.render.disabled=!state.dry;
    $("#progress").value=0;
    message("設定を変更したため、前のWAV変換を中止しました。");
  }
  const p=state.player;
  if(!p)return;
  const preflight=prepareStreamSettings(settings());
  const current=preflight.settings;
  if(p.directDry){
    // Preview keeps playing; the user can fix the wet settings in place.
    if(!preflight.ok){
      indicator("原音再生中 · 変換設定未反映 · "+preflight.field);
      message("原音再生中。変換設定は未反映: "+preflight.message,"error");
    }else{
      indicator("原音再生中 · 変換再生に切替可能");
      message("原音再生中。変換設定を反映するには「変換して再生」を選択してください。");
    }
    return;
  }
  if(!preflight.ok){
    if(state.rebuildTimer){clearTimeout(state.rebuildTimer);state.rebuildTimer=null;}
    p.feedback.reject(preflight.message);
    message("音声処理へ未反映: "+preflight.message,"error");
    indicator("設定未反映 · "+preflight.field);
    return;
  }
  if(current.qualityIndex!==p.quality||current.hopDiv!==p.hopDiv||current.engine!==p.engine){
    // Debounce costly stream rebuilds while the user is selecting; keep
    // current playback position rather than stopping on every input event.
    if(state.rebuildTimer)clearTimeout(state.rebuildTimer);
    state.rebuildTimer=setTimeout(async()=>{
      state.rebuildTimer=null;
      const active=state.player;if(!active)return;
      const offset=playPosition(),mode=active.mode;
      const nextEpoch=state.transportEpoch+1;
      await stop();
      if(state.transportEpoch!==nextEpoch)return;
      await play(mode,offset);
    },180);
    p.feedback.rebuild();
    indicator("設定を反映するため音声処理を切替中…");
    return;
  }
  // A rapid switch A→B→A (or FFT selection rollback) must not leave a
  // pending rebuild after the current processor already matches settings.
  if(state.rebuildTimer){clearTimeout(state.rebuildTimer);state.rebuildTimer=null;}
  const nextNotice=preflight.warnings.join(" ");
  if(p.notice!==nextNotice||$("#status").dataset.kind==="error"){
    p.notice=nextNotice;
    message(nextNotice||"リアルタイム音声処理中。",
      nextNotice?"warning":"info");
  }
  const revision=++state.settingsRevision;
  p.feedback.request(revision);
  syncAuditionFeedback();
  p.worklet.port.postMessage({
    type:"params",settings:current,activeQualityIndex:p.quality,revision
  });
  // ACK/pending state is tracked internally; no per-gesture banner churn.
}
// #79 M1 first vertical slice: one physical-Hz control using the shared
// canonical binding. The existing #low source remains the dual-thumb gesture
// proxy, not a second physical/DSP authority.
const lowNormalizedFromHz=hz=>hz<=20?
  .2*Math.log(hz/MIN_POSITIVE_HZ)/Math.log(20/MIN_POSITIVE_HZ):
  .2+.8*Math.log(hz/20)/Math.log(1000);
lowUnitControl=mountFrequencyUnitField({
  descriptor:defineParameter({
    id:"low",min:MIN_POSITIVE_HZ,max:20000,defaultValue:20,
    units:["hz","note","percent"],
    rail:{toPosition:lowNormalizedFromHz,fromPosition:t=>hzFromScale(t*1000)},
    digits:3,
    snap:{unit:"note",mode:"step",step:1,thresholdPx:6,during:["slider"]}
  }),
  field:$("#low-value"),select:$("#low-unit"),
  slider:$("#low"),railRoot:$("#dual-range"),
  getDigits:displayDigits,
  initialValue:hzFromScale($("#low").value),
  onValueChange:()=>{updateParams("low");updateEngineInfo();}
});
// The upper H frequency shares exactly the same descriptor/interaction
// contract as L, retaining the existing dual-thumb event transport.
highUnitControl=mountFrequencyUnitField({
  descriptor:defineParameter({
    id:"high",min:MIN_POSITIVE_HZ,max:20000,defaultValue:16000,
    units:["hz","note","percent"],
    rail:{toPosition:lowNormalizedFromHz,fromPosition:t=>hzFromScale(t*1000)},
    digits:3,
    snap:{unit:"note",mode:"step",step:1,thresholdPx:6,during:["slider"]}
  }),
  field:$("#high-value"),select:$("#high-unit"),
  slider:$("#high"),railRoot:$("#dual-range"),
  getDigits:displayDigits,
  initialValue:hzFromScale($("#high").value),
  onValueChange:()=>{updateParams("high");updateEngineInfo();}
});
// Pivot P has an explicit 0-Hz rail position; positive frequencies begin at
// 0.001 Hz and retain the original piecewise logarithmic gesture scale.
// 0 Hz has no musical pitch; keep the selected note view, displaying “—” instead.
const pivotNormalizedFromHz=hz=>hz<=0?0:hz<=20?
  (1+199*Math.log(Math.max(.001,hz)/.001)/Math.log(20000))/1000:
  (200+800*Math.log(Math.min(20000,hz)/20)/Math.log(1000))/1000;
const pivotHzFromNormalized=t=>t<=0?0:pivotFromScale(Math.max(1,t*1000));
pivotUnitControl=mountFrequencyUnitField({
  descriptor:defineParameter({
    id:"axis-pivot",min:0,max:20000,defaultValue:350,
    units:["hz","note","percent"],
    rail:{toPosition:pivotNormalizedFromHz,fromPosition:pivotHzFromNormalized},
    digits:3,
    snap:{unit:"note",mode:"step",step:1,thresholdPx:6,during:["slider"]}
  }),
  field:$("#axis-pivot-value"),select:$("#pivot-unit"),
  slider:$("#axis-pivot"),railRoot:$("#axis-pivot"),
  getDigits:displayDigits,initialValue:350,
  onValueChange:()=>{
    if(isHarmonicPivotLinked())syncPivotToHarmonic();
    updateParams("axis-pivot");updateEngineInfo();
  }
});
// Engine A extraction floor has the same nonzero Hz log rail as L/H.
aMinUnitControl=mountFrequencyUnitField({
  descriptor:defineParameter({
    id:"a-min",min:MIN_POSITIVE_HZ,max:20000,defaultValue:20,
    units:["hz","note","percent"],
    rail:{toPosition:lowNormalizedFromHz,fromPosition:t=>hzFromScale(t*1000)},
    digits:3,
    snap:{unit:"note",mode:"step",step:1,thresholdPx:6,during:["slider"]}
  }),
  field:$("#a-min-value"),select:$("#a-min-unit"),
  slider:$("#a-min"),railRoot:$("#a-min"),
  getDigits:displayDigits,initialValue:20,
  onValueChange:()=>{updateParams("a-min");updateEngineInfo();}
});
// Signed slope s has no pitch or Hz interpretation: only signed × and the
// original linear physical rail%, with optional anchors −1, 0, +1.
slopeUnitControl=mountParameterUnitField({
  descriptor:defineParameter({
    id:"axis-slope",min:-4,max:4,defaultValue:1,
    units:["ratio","percent"],
    rail:{toPosition:value=>(value+4)/8,fromPosition:t=>8*t-4},
    digits:3,
    snap:{unit:"ratio",mode:"targets",targets:[-1,0,1],
          thresholdPx:6,during:["slider"]}
  }),
  field:$("#axis-slope-value"),select:$("#axis-slope-unit"),
  slider:$("#axis-slope"),
  railRoot:$("#axis-slope"),getDigits:displayDigits,initialValue:1,
  onValueChange:()=>{updateParams("axis-slope");updateEngineInfo();}
});
// Other controls retain the legacy input binding until independently migrated.
const inline={
  "a-band-value":["a-band",v=>v,"a-band",1,8],
  "a-quality-value":["a-quality",v=>v,"a-quality",0,100],
  "curvature-value":["curvature",v=>v,"curvature",0,1],
  "axis-shift-value":["axis-shift",v=>v,"axis-shift",-2,2],
  "crusher-bits-value":["crusher-bits",v=>v,"crusher-bits",2,16],
  "crusher-hold-value":["crusher-hold",v=>sliderFromFrequency(v,state.ctx?.sampleRate||state.decoded?.sampleRate||48000),"crusher-hold",0,192000]
};
for(const [id,[range,convert,changed,min,max]] of Object.entries(inline)){
  if(id==="axis-shift-value")continue; // dynamic u/%/Hz/ratio projection below
  const field=$("#"+id);
  const integer=range==="crusher-bits"||range==="a-band"||range==="a-quality";
  const normalized=value=>{
    const v=clamp(value,min,max);
    return integer?Math.round(v):round3(v);
  };
  const toDsp=value=>normalized(value);
  const apply=()=>{
    if(field.value.trim()==="")return;
    const raw=Number(field.value);
    if(!Number.isFinite(raw))return;
    const value=normalized(raw);
    // Slider is only a coarse visual/gesture proxy. The exact value is
    // kept separately and sent to Rust instead of reading snapped range.value.
    state.precise[range]=toDsp(value);
    $("#"+range).value=String(convert(value));
    if(range==="axis-pivot"&&isHarmonicPivotLinked())syncPivotToHarmonic();
    updateParams(changed);updateEngineInfo();
  };
  field.addEventListener("focus",()=>{
    if(state.precise[range]!==undefined){
      const number=state.precise[range];
      const typed=number;
      field.value=String(round3(typed));
    }
    field.select();
  });
  field.addEventListener("input",apply);
  field.addEventListener("change",apply);
  field.addEventListener("blur",()=>{
    apply();
    // The interface rounds to 2 decimals, but the DSP value remains 3-decimal exact.
    const native=state.precise[range];
    const human=native;
    if(Number.isFinite(human))showNumber(id,human);
  });
  field.addEventListener("keydown",event=>{if(event.key==="Enter")field.blur();});
}
// #79 M3: one shared typed-% interaction controller for the five fraction
// parameters. Canonical bindings own values; per-parameter callbacks retain
// their distinct WebAudio-vs-Rust and comparison semantics.
const typedPercentEditors=[
  ["wet",wetBinding,refreshWetView,()=>{
    markComparisonEdited();labels();tuneWet();drawCurve();syncAuditionFeedback();
  }],
  ["a-reverb",aReverbBinding,refreshAReverbView,()=>{
    updateParams("a-reverb");updateEngineInfo();
  }],
  ["zero-reflect",zeroReflectBinding,refreshZeroReflectView,()=>{
    updateParams("zero-reflect");updateEngineInfo();
  }],
  ["zero-decay",zeroDecayBinding,refreshZeroDecayView,()=>{
    updateParams("zero-decay");updateEngineInfo();
  }],
  ["invert",invertBinding,refreshInvertView,()=>{
    updateParams("invert");updateEngineInfo();
  }]
];
for(const [id,binding,refresh,onChanged] of typedPercentEditors)
  mountPercentParameterField({field:$("#"+id+"-value"),binding,refresh,onChanged});
// The move slider stores canonical u. Notation is conditional on curvature p,
 // and only a valid inverse conversion may update the DSP control.
 const moveField=$("#axis-shift-value"),moveUnit=$("#axis-shift-unit");
 const parseMove=()=>{
   if(moveField.value.trim()==="")return;
   const value=Number(moveField.value);
   if(!Number.isFinite(value))return;
   const p=settings();
   try{
     const u=axisShiftCanonical(value,moveUnit.value,p.curvature,p.axisReference);
     state.precise["axis-shift"]=u;
     $("#axis-shift").value=String(round3(u));
     updateParams("axis-shift");updateEngineInfo();
   }catch{moveField.dataset.invalid="true";return;}
   delete moveField.dataset.invalid;
 };
 moveField.addEventListener("input",parseMove);
 moveField.addEventListener("change",parseMove);
 moveField.addEventListener("focus",()=>{refreshAxisShiftView(settings(),true);moveField.select();});
 moveField.addEventListener("blur",()=>{parseMove();refreshAxisShiftView(settings(),true);});
 moveField.addEventListener("keydown",e=>{if(e.key==="Enter")moveField.blur();});
 moveUnit.addEventListener("change",()=>refreshAxisShiftView(settings(),true));
 $("#pivot-follow-low").addEventListener("change",()=>{updateParams("low");updateEngineInfo();});
 // Compact shared rails. Actual parameter updates still use the same
// source ranges and existing native Rust AudioWorklet/WAV bindings.
dualControls.bounds=mountDualThumb($("#dual-range"),["low","high"],[
  v=>hzText(lowUnitControl?.value??hzFromScale(v)),v=>hzText(highUnitControl?.value??hzFromScale(v))
]);
dualControls.reflection=mountDualThumb($("#reflection-dual"),
  ["zero-reflect","zero-decay"],[
    v=>"合成率 "+v+"%",v=>"反射率 "+v+"%"
  ]);
dualControls.shape=mountDualThumb($("#shape-dual"),
  ["invert","curvature"],[
    v=>"反転 "+Number((v*100).toFixed(1))+"%",
    v=>"移動尺度 p="+v+"（0=対数、1=線形）"
  ]);
function cycleGraphView(){
  const next=graphMax===2000?20000:graphMax===20000?20:2000;
  const scale=$("#graph-log");
  if(next===20){
    graphAlphaBeforeZoom=Number(scale.value);
    scale.value="100"; // 0.001Hz to 20Hz requires logarithmic visual resolution.
  }else if(graphMax===20){
    scale.value=String(graphAlphaBeforeZoom);
  }
  graphMax=next;drawCurve();
}
$("#curve").addEventListener("click",()=>{cycleGraphView();});
$("#curve").addEventListener("keydown",event=>{
  if(event.key==="Enter"||event.key===" "){event.preventDefault();cycleGraphView();}
});
for(const name of ["low","high","curvature","invert","zero-reflect","zero-decay","axis-shift","axis-pivot","axis-slope","a-min","a-band","a-quality","a-reverb","ring-enabled","rational-enabled"]){
  $("#"+name).addEventListener("input",()=>{
    if(name==="low"){lowUnitControl.fromSlider();return;}
    if(name==="high"){highUnitControl.fromSlider();return;}
    if(name==="axis-pivot"){pivotUnitControl.fromSlider();return;}
    if(name==="a-min"){aMinUnitControl.fromSlider();return;}
    if(name==="axis-slope"){slopeUnitControl.fromSlider();return;}
    if(name==="a-reverb"){
      aReverbBinding.setPosition(Number($("#a-reverb").value)/100,{snap:false,notify:false});
      refreshAReverbView();updateParams(name);updateEngineInfo();return;
    }
    if(name==="zero-reflect"){
      zeroReflectBinding.setPosition(Number($("#zero-reflect").value)/100,{snap:false,notify:false});
      refreshZeroReflectView();updateParams(name);updateEngineInfo();return;
    }
    if(name==="zero-decay"){
      zeroDecayBinding.setPosition(Number($("#zero-decay").value)/100,{snap:false,notify:false});
      refreshZeroDecayView();updateParams(name);updateEngineInfo();return;
    }
    if(name==="invert"){
      invertBinding.setPosition(Number($("#invert").value),{snap:false,notify:false});
      refreshInvertView();updateParams(name);updateEngineInfo();return;
    }
    delete state.precise[name];
    if(name==="rational-enabled"&&!$("#rational-enabled").checked&&isHarmonicPivotLinked()){
      $("#harmonic-pivot-link").checked=false;
      rationalEnabledByLink=false;
      linkFeedback("有理数シフトをOFFにしたため、H↔P＋音声適用の連動を解除しました。");
    }
    if(name==="axis-pivot"&&isHarmonicPivotLinked())syncPivotToHarmonic();
    updateParams(name);updateEngineInfo();
  });
}
// Native mobile selectors dispatch CHANGE; do not wait for a slider gesture.
for(const name of ["mode","outside","quality","overlap","engine"]){
  $("#"+name).addEventListener("change",()=>{updateParams(name);updateEngineInfo();});
}
$("#engine-auto").addEventListener("change",()=>{updateParams("engine-auto");updateEngineInfo();});
$("#graph-log").addEventListener("input",drawCurve);
$("#processing-min-hz").addEventListener("change",event=>{
  const v=Number(event.target.value);
  if(!Number.isFinite(v)||v<.001||v>20000){event.target.value=String(lowUnitControl.value);return;}
  lowUnitControl.setCanonical(v);updateParams("low");updateEngineInfo();
});
$("#decimal-digits").addEventListener("change",()=>{
  labels();drawCurve();renderHarmonicPanel(foldPoint,axisMarker,settings);
  lowUnitControl.refresh();
  highUnitControl.refresh();
  pivotUnitControl.refresh();
  aMinUnitControl.refresh();
  slopeUnitControl.refresh();
  updateSineLabel();
});
$("#wet").addEventListener("input",()=>{
  wetBinding.setPosition(Number($("#wet").value),{snap:false,notify:false});
  refreshWetView();
  markComparisonEdited();labels();tuneWet();drawCurve();syncAuditionFeedback();
});
$("#slope-one").addEventListener("click",()=>{
  slopeUnitControl.setCanonical(1);
  updateParams("axis-slope");updateEngineInfo();
});
$("#axis-zero").addEventListener("click",()=>{
  delete state.precise["axis-shift"];
  $("#axis-shift").value="0";
  updateParams("axis-shift");
  updateEngineInfo();
});

for(const id of ["crusher-enabled","crusher-bits","crusher-hold"]){
  $("#"+id).addEventListener("input",()=>{
    delete state.precise[id];
    $("#crusher-bits-value").value=$("#crusher-bits").value;
    $("#crusher-hold-value").value=String(Math.round(frequencyFromSlider($("#crusher-hold").value,state.ctx?.sampleRate||state.decoded?.sampleRate||48000)));
    updateParams(id);updateEngineInfo();
  });
}

controls.dry.addEventListener("click",()=>play("dry"));
controls.wet.addEventListener("click",()=>play("wet"));
controls.stop.addEventListener("click",()=>{
  if(comparisonPending){
    comparisonPending=null;
    comparisonMessage("停止しました · 加工設定の反映は未確認","ready");
  }
  void stop();
});
window.addEventListener("resize",()=>{drawCurve();drawAudio();});
window.addEventListener("pagehide",()=>{if(state.rebuildTimer)clearTimeout(state.rebuildTimer);stop();if(state.offlineWorker)state.offlineWorker.terminate();});
// Cold-start audio decode on iOS can stall after the file picker closes.
// A single OfflineAudioContext promise with a 45s timeout produced the
// reported "loading forever" appearance; do not require a second picker tap.
async function withDecodeDeadline(promise,ms,phase){
  let timer;
  try{
    return await Promise.race([promise,new Promise((_,reject)=>{
      timer=setTimeout(()=>reject(Error(phase+"が応答しませんでした")),ms);
    })]);
  }finally{clearTimeout(timer);}
}
async function decodeFileWithoutPlayback(file,token){
  // Read once; decodeAudioData can detach its source buffer. Retry with a copy.
  const bytes=await withDecodeDeadline(file.arrayBuffer(),20000,"ファイル読み込み");
  if(token!==state.loadToken)return null;
  const Native=window.AudioContext||window.webkitAudioContext;
  const Offline=window.OfflineAudioContext||window.webkitOfflineAudioContext;
  const candidates=[
    ...(Native?[["通常",()=>new Native()]]:[]),
    ...(Offline?[["オフライン",()=>new Offline(1,1,44100)]]:[])
  ];
  if(!candidates.length)throw Error("このブラウザでは音声を解析できません");
  const failures=[];
  for(const [index,[name,create]] of candidates.entries()){
    if(token!==state.loadToken)return null;
    let ctx;
    try{
      message(index?"別の音声デコーダで再試行しています…":"音声を解析中…");
      ctx=create();
      const decoded=await withDecodeDeadline(ctx.decodeAudioData(bytes.slice(0)),20000,name+"デコード");
      return token===state.loadToken?decoded:null;
    }catch(error){failures.push(name+": "+(error?.message||String(error)));}
    finally{if(ctx?.close)void ctx.close().catch(()=>{});}
  }
  throw Error("音声形式・コーデック・ブラウザの対応状況を確認してください。"+failures.join(" / "));
}
async function load(file){
  if(!file)return;
  const token=++state.loadToken;
  const previousReady=Boolean(state.dry);
  // Never discard the current song merely because a *replacement* failed.
  // Decode/validate into local state, then commit only after full success.
  try{
    if(file.size>75_000_000)throw Error("最大75MBです");
    $("#file-meta").textContent=file.name+" · 読み込み中"+(previousReady?"（現在の音声は保持）":"");
    message("音声を開いています…"+(previousReady?" 現在の音声はそのまま使えます。":""));
    const data=await decodeFileWithoutPlayback(file,token);
    if(token!==state.loadToken||!data)return;
    const count=Math.min(2,data.numberOfChannels);
    const length=Math.min(data.length,Math.floor(data.sampleRate*MAX_PREVIEW_SECONDS));
    if(length<4096)throw Error("短すぎる音声です");
    const dry=Array.from({length:count},(_,i)=>data.getChannelData(i).slice(0,length));
    if(token!==state.loadToken)return;

    // Atomic replacement boundary: old playable audio and completed offline
    // WAV survive until the new source is guaranteed to be usable.
    await stop();
    if(token!==state.loadToken)return;
    if(state.rebuildTimer){clearTimeout(state.rebuildTimer);state.rebuildTimer=null;}
    if(state.offlineWorker){state.offlineWorker.terminate();state.offlineWorker=null;}
    state.offline=null;state.exportIdentity=null;state.sourceGeneration++;
    state.decoded={sampleRate:data.sampleRate};
    state.dry=dry;state.seek=0;state.lastStats=null;
    state.sourceGeneration++;
    comparisonSlots.A=null;comparisonSlots.B=null;
    comparisonPending=null;comparisonCurrent=null;
    updateComparisonButtons();
    comparisonMessage("新しい音源です · A/Bを記録してください","idle");
    state.name=file.name.replace(/\.[^.]+$/,"");
    mediaStatus(false);
    state.fileMeta=file.name+" · "+duration().toFixed(1)+"秒 · "+data.sampleRate+"Hz · "+count+"ch";
    $("#file-meta").textContent=state.fileMeta;
    labels("high");drawCurve();drawAudio();refreshStatusSeek();
    controls.dry.disabled=false;controls.wet.disabled=false;
    controls.stop.disabled=true;
    controls.render.disabled=false;controls.download.disabled=true;
    $("#progress").value=0;
    indicator("停止中 · 音声選択済み");
    message("読み込み完了。再生できます。");
  }catch(error){
    if(token!==state.loadToken)return;
    // The mobile status HUD may be collapsed; make the actual decoder/file
    // error visible beside the same source picker, not only in diagnostics.
    $("#file-meta").textContent=(previousReady?state.fileMeta+" · 新しい音声":"選択した音声")+
      "の読込失敗: "+error.message;
    message("音声を開けませんでした: "+error.message+
      (previousReady?"。以前の音声は保持しています。":""),"error");
  }
}

// FileProvider-backed iOS selections may remain externally referenced until
// their bytes are read. Keep the native selected File attached during async
// read/decode; clear afterwards so the same file can be chosen again.
const audioInput=$("#audio-file");
audioInput.addEventListener("change",async()=>{
  const file=audioInput.files?.[0];
  if(!file)return;
  try{await load(file);}
  finally{
    // Another choice may have superseded this one during a slow decode.
    if(audioInput.files?.[0]===file)audioInput.value="";
  }
});
const drop=$("#drop");
// The full-surface native file input opens via an actual tap. Do not
// programmatically click it from a delegated handler: iOS/WebKit can
// reject synthetic picker activation, especially when modules load late.
drop.addEventListener("keydown",e=>{
  if(e.target.id!=="audio-file"&&(e.key==="Enter"||e.key===" ")){
    e.preventDefault();$("#audio-file").click();
  }
});
drop.addEventListener("dragover",e=>{e.preventDefault();drop.classList.add("hover");});
drop.addEventListener("dragleave",()=>drop.classList.remove("hover"));
drop.addEventListener("drop",e=>{e.preventDefault();drop.classList.remove("hover");load(e.dataTransfer.files[0]);});

// WAV export deliberately stays OFFLINE; not required by live playback.
controls.render.addEventListener("click",()=>{
  if(!state.dry||state.offlineWorker)return;
  // Reject oversized export BEFORE constructing a Worker, so the button
  // remains usable for a subsequent shorter file after rejection.
  if(!canExportChannels(state.dry)){
    message("10分の試聴は可能です。WAV一括書出しはメモリ保護のため合計4000万サンプルまでです。","warning");
    return;
  }
  const preflight=prepareStreamSettings({
    ...settings(),sampleRate:state.decoded.sampleRate
  });
  const renderSettings=preflight.settings;
  if(!preflight.ok){
    message("WAV書出し設定未反映: "+preflight.message,"error");
    return;
  }
  // Wet is the final samplewise mix performed at download, NOT a new
  // spectral render. The accepted Web contract exports 0/50/100% Mix from
  // one complete processed buffer without rendering the track three times.
  const {wet:unusedMix,...spectralSettings}=renderSettings;
  const renderIdentity=freezeExportIdentity(state.sourceGeneration,spectralSettings);
  state.offline=null;state.exportIdentity=renderIdentity;
  controls.download.disabled=true;controls.render.disabled=true;
  $("#progress").value=0;
  message("WAV書出し用オフライン処理中（試聴とは独立）…"+
    (preflight.warnings.length?" "+preflight.warnings.join(" "):""),
    preflight.warnings.length?"warning":"info");
  const worker=new Worker(new URL("./processor.worker.mjs",import.meta.url),{type:"module"});
  state.offlineWorker=worker;
  worker.onmessage=({data})=>{
    if(state.offlineWorker!==worker)return;
    if(data.type==="progress")$("#progress").value=Math.round(data.value*100);
    else if(data.type==="done"){
      state.offline=data.channels;
      controls.download.disabled=false;
      controls.render.disabled=false;worker.terminate();state.offlineWorker=null;
      $("#progress").value=100;
      message("オフライン書出し用の変換が完了しました。"+
        (preflight.warnings.length?" "+preflight.warnings.join(" "):""),
        preflight.warnings.length?"warning":"info");
    }else if(data.type==="error"){
      state.exportIdentity=null;
      controls.render.disabled=false;worker.terminate();state.offlineWorker=null;
      message("オフライン書出し失敗: "+data.message,"error");
    }
  };
  worker.onerror=e=>{
    if(state.offlineWorker!==worker)return;
    state.exportIdentity=null;
    controls.render.disabled=false;worker.terminate();state.offlineWorker=null;
    message("オフライン処理失敗: "+e.message,"error");
  };
  const copies=state.dry.map(c=>new Float32Array(c));
  worker.postMessage({
    type:"process",channels:copies,sampleRate:state.decoded.sampleRate,settings:renderSettings
  },copies.map(c=>c.buffer));
});
function makeWav(channels,rate){
  const n=channels[0].length,count=channels.length;
  const ab=new ArrayBuffer(44+n*count*2),view=new DataView(ab);
  const write=(o,s)=>{for(let i=0;i<s.length;i++)view.setUint8(o+i,s.charCodeAt(i));};
  write(0,"RIFF");view.setUint32(4,36+n*count*2,true);write(8,"WAVE");
  write(12,"fmt ");view.setUint32(16,16,true);view.setUint16(20,1,true);
  view.setUint16(22,count,true);view.setUint32(24,rate,true);
  view.setUint32(28,rate*count*2,true);view.setUint16(32,count*2,true);
  view.setUint16(34,16,true);write(36,"data");view.setUint32(40,n*count*2,true);
  let offset=44;
  for(let i=0;i<n;i++)for(let c=0;c<count;c++){
    const sample=clamp(channels[c][i],-1,1);
    view.setInt16(offset,sample<0?Math.round(sample*32768):Math.round(sample*32767),true);
    offset+=2;
  }
  return new Blob([ab],{type:"audio/wav"});
}
controls.download.addEventListener("click",()=>{
  if(!state.offline)return;
  const check=prepareStreamSettings({
    ...settings(),sampleRate:state.decoded.sampleRate
  });
  const {wet:currentMix,...spectralNow}=check.settings||{};
  if(!check.ok||!matchesExportIdentity(state.exportIdentity,state.sourceGeneration,spectralNow)){
    state.offline=null;state.exportIdentity=null;
    controls.download.disabled=true;
    message("変更後の設定に一致するWAVではありません。再度変換してください。","warning");
    return;
  }
  const mixed=state.offline.map((ch,i)=>mixWet(state.dry[i],ch,currentMix));
  const url=URL.createObjectURL(makeWav(mixed,state.decoded.sampleRate));
  const el=document.createElement("a");el.href=url;el.download=state.name+"-frequency-warp.wav";
  document.body.append(el);el.click();el.remove();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
});
// Settings are part of the same live parameter model as the front-panel knobs.
// Modal entry/exit lives in the minimal, separately loaded entry-controls.js.
// It remains available even when a Rust/DSP module import fails.
$("#settings-reset").addEventListener("click",()=>{
  const defaults={
    low:"200",high:"974",curvature:"1",invert:"0",wet:"1","axis-shift":"0",
    engine:"1",mode:"reciprocal",outside:"pass",quality:"eco",
    overlap:"4","zero-reflect":"100","zero-decay":"0","harmonic-count":"5","decimal-digits":"3","graph-log":"0","a-band":"1","a-quality":"0"
  };
  state.precise=Object.create(null);
  wetBinding.reset({notify:false});
  aReverbBinding.reset({notify:false});
  zeroReflectBinding.reset({notify:false});
  zeroDecayBinding.reset({notify:false});
  invertBinding.reset({notify:false});
  lowUnitControl.reset();
  highUnitControl.reset();
  pivotUnitControl.reset();
  aMinUnitControl.reset();
  slopeUnitControl.reset();
  resetHarmonicControls();
  // Reference sine is an independent monitor: leave its frequency/playback
  // alone, but restore the default ON snap preference of its unit control.
  sineUnitControl?.setSnapEnabled(true);
  for(const [id,value] of Object.entries(defaults))$("#"+id).value=value;
  $("#ring-enabled").checked=false;$("#rational-enabled").checked=false;
  $("#carrier-link").checked=false;
  $("#harmonic-pivot-link").checked=false;
  $("#pivot-link-target").value="H";
  restoreRationalAfterUnlink();
  $("#pivot-follow-low").checked=false;
  $("#axis-shift-unit").value="coordinate";
  linkFeedback("");
  $("#engine-auto").checked=false;
  $("#a-reverb").value="0";
  $("#a-reverb-value").value="0";$("#a-band-value").value="1";$("#a-quality-value").value="0";
  $("#crusher-enabled").checked=false;
  $("#crusher-bits").value="8";$("#crusher-hold").value="880";
  $("#crusher-bits-value").value="8";
  $("#crusher-hold-value").value="12000";
  refreshWetView(true);
  refreshAReverbView(true);
  refreshZeroReflectView(true);
  refreshZeroDecayView(true);
  refreshInvertView(true);
  labels();tuneWet();updateParams("settings-reset");updateEngineInfo();
  document.dispatchEvent(new Event("fw:virtual-root-external-change"));
  // Controls resetting is not proof that Rust/WASM has acknowledged them.
  // Preserve any validation error and wait for the latest revision's ACK.
  const phase=state.player?.feedback?.current?.phase;
  if(!state.player)
    message("操作値を初期値へ戻しました。再生位置は保持されます。");
  else if(state.player.directDry)
    message("操作値を初期値へ戻しました。原音は再生中（変換DSP未使用）です。");
  else if(phase==="pending"||phase==="rebuilding")
    message("操作値を初期値へ戻しました。音声への反映確認中…再生位置は保持されます。");
});
function showTab(tab){
  const math=tab==="math";
  // Keep graph and 3-harmonic summary visible when the full formula panel is open.
  $("#view-map").hidden=false;$("#view-math").hidden=!math;
  $("#tab-map").setAttribute("aria-selected",String(!math));
  $("#tab-math").setAttribute("aria-selected",String(math));
  $("#tab-map").tabIndex=math?-1:0;
  $("#tab-math").tabIndex=math?0:-1;
  requestAnimationFrame(drawCurve);
}
$("#tab-map").addEventListener("click",()=>showTab("map"));
$("#tab-math").addEventListener("click",()=>showTab("math"));
$("#mini-expand").addEventListener("click",()=>{
  showTab("math");
  // The disclosure is below a square graph; leave the graph in place, but
  // move keyboard/screen-reader focus to the content that was just revealed.
  const heading=$("#view-math .section-header h2");
  heading.tabIndex=-1;
  heading.focus({preventScroll:true});
  heading.scrollIntoView({block:"nearest",behavior:"auto"});
});
for(const [node,tab] of [["#tab-map","map"],["#tab-math","math"]]){
  $(node).addEventListener("keydown",e=>{
    if(e.key!=="ArrowLeft"&&e.key!=="ArrowRight")return;
    e.preventDefault();const next=tab==="map"?"math":"map";
    showTab(next);$("#tab-"+next).focus();
  });
}
// WebAudio reference sine is a monitoring aid, not a competing DSP engine.
const NOTE_NAMES=["C","C♯","D","D♯","E","F","F♯","G","G♯","A","A♯","B"];
const sineHzAtMidi=midi=>440*2**((midi-69)/12);
const sineMidiAtHz=hz=>69+12*Math.log2(hz/440);
sineUnitControl=mountFrequencyUnitField({
  descriptor:defineParameter({
    id:"sine-hz",min:sineHzAtMidi(36),max:sineHzAtMidi(96),
    defaultValue:440,units:["hz","note","percent"],
    rail:{toPosition:hz=>(sineMidiAtHz(hz)-36)/60,
          fromPosition:t=>sineHzAtMidi(36+60*t)},
    digits:3,
    snap:{unit:"note",mode:"step",step:1,thresholdPx:6,during:["slider"]}
  }),
  field:$("#sine-hz"),select:$("#sine-unit"),
  slider:$("#sine-pitch"),railRoot:$("#sine-pitch"),
  getDigits:displayDigits,initialValue:440,
  onValueChange:()=>updateSineLabel()
});
const sinePitch=()=>sineMidiAtHz(sineUnitControl.value);
const sineFrequency=()=>sineUnitControl.value;
function updateSineLabel(){
  const value=sinePitch(),nearest=Math.round(value);
  const note=NOTE_NAMES[((nearest%12)+12)%12]+(Math.floor(nearest/12)-1);
  // Only the visible cents readout is integer; the oscillator stays Float64.
  const cents=Math.round((value-nearest)*100);
  $("#sine-note").textContent=note;
  showNumber("sine-cent",cents);
  showNumber("sine-hz",sineFrequency());
  if(state.sine&&state.ctx)state.sine.osc.frequency.setTargetAtTime(sineFrequency(),state.ctx.currentTime,.012);
}
function stopSine(){
  const sine=state.sine;state.sine=null;
  if(!sine)return;
  try{sine.osc.stop();sine.osc.disconnect();sine.gain.disconnect();}catch{}
}
// The reference oscillator, MIDI rail and cents field are views of exactly
// one canonical Hz value. MIDI's .01 source step remains a coarse gesture.
$("#sine-pitch").addEventListener("input",()=>sineUnitControl.fromSlider());
$("#sine-cent").addEventListener("input",()=>{
  if($("#sine-cent").value==="")return;
  const cents=clamp(Number($("#sine-cent").value),-50,50);
  if(!Number.isFinite(cents))return;
  const root=Math.round(sinePitch());
  const pitch=clamp(root+cents/100,36,96);
  sineUnitControl.setCanonical(sineHzAtMidi(pitch));
  updateSineLabel();
});
$("#sine-cent").addEventListener("focus",()=>{$("#sine-cent").value=String(Math.round((sinePitch()-Math.round(sinePitch()))*100));});
$("#sine-cent").addEventListener("blur",()=>showNumber("sine-cent",Math.round((sinePitch()-Math.round(sinePitch()))*100)));
$("#sine-volume").addEventListener("input",()=>{
  const v=Number($("#sine-volume").value);
  $("#sine-volume-value").textContent=v+"%";
  if(state.sine&&state.ctx)state.sine.gain.gain.setTargetAtTime(v/100*.32,state.ctx.currentTime,.012);
});
$("#sine-enabled").addEventListener("change",async()=>{
  if(!$("#sine-enabled").checked){stopSine();return;}
  try{
    const ctx=await context();
    if(!$("#sine-enabled").checked)return;
    stopSine();
    const osc=ctx.createOscillator(),gain=ctx.createGain();
    osc.type="sine";osc.frequency.value=sineFrequency();
    gain.gain.value=Number($("#sine-volume").value)/100*.32;
    osc.connect(gain);gain.connect(ctx.destination);
    osc.start();state.sine={osc,gain};updateSineLabel();
  }catch(error){
    stopSine();$("#sine-enabled").checked=false;
    message("補助サイン波の起動失敗: "+error.message,"error");
  }
});
window.addEventListener("pagehide",stopSine);
updateSineLabel();
$("#harmonic-pivot-link").addEventListener("change",()=>{
  if(isHarmonicPivotLinked()){
    // This is now an explicitly labelled audible link, not a decorative
    // H→P constraint with an unrelated silent rational stage.
    rationalEnabledByLink=!$("#rational-enabled").checked;
    $("#rational-enabled").checked=true;
    syncHarmonicToPivot();
  }else{
    restoreRationalAfterUnlink();
    linkFeedback("");
  }
  updateParams("harmonic-pivot-link");updateEngineInfo();
});
$("#pivot-link-target").addEventListener("change",()=>{
  if(isHarmonicPivotLinked())syncHarmonicToPivot();
  updateParams("pivot-link-target");updateEngineInfo();
});
attachHarmonicPanel(id=>{
  if(isHarmonicPivotLinked()&&["fundamental","denominator","pitch-ratio"].includes(id)){
    syncHarmonicToPivot();
  }else if(["fundamental","denominator","pitch-ratio"].includes(id)){
    linkFeedback("");
  }
  updateParams(id);updateEngineInfo();
  document.dispatchEvent(new Event("fw:virtual-root-external-change"));
},foldPoint,axisMarker,settings);
// The new user-goal workbench is separate from the retained legacy maths UI.
// One validated transaction updates the existing canonical harmonic owners.
// Theoretical H outside current DSP capability stays a draft, never a 0Hz P.
mountVirtualRootWorkbench({
  onCurrent:()=>captureHarmonicConfiguration(),
  onApply:plan=>{
    if(!plan.capability.rationalStage)throw Error("現行DSPでは指定配置を再現できません");
    const candidate={...captureHarmonicConfiguration(),
      F:plan.F,m:plan.m,n:plan.numerator,q:plan.q,r:plan.ratio};
    const prospective={...settings(),
      pitchRatio:plan.ratio,shiftHz:plan.shift,axisReference:plan.pitched,
      rationalEnabled:true};
    const gate=prepareStreamSettings(prospective);
    if(!gate.ok)throw Error(gate.message);
    // This workbench controls the harmonic *grid* independently of the
    // physical Warp pivot P. Never fabricate a physical zero position.
    if(isHarmonicPivotLinked()){
      $("#harmonic-pivot-link").checked=false;
      restoreRationalAfterUnlink();
      linkFeedback("新しい仮想基音操作では物理起点PとHを別管理します。Pは保持しました。");
    }
    restoreHarmonicConfiguration(candidate);
    $("#rational-enabled").checked=true;
    updateParams("virtual-root-workbench");
    updateEngineInfo();
  }
});
labels();drawCurve();updateEngineInfo();refreshPlayhead();
ensureSharedCore().catch(()=>{});
// Set only after all interactive controls have registered successfully.
document.documentElement.dataset.fwBoot="ready";
