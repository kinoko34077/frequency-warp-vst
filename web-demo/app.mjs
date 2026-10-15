import {QUALITY,mixWet} from "./dsp.mjs";
import {frequencyFromSlider,sliderFromFrequency,holdFromFrequency,drawCrusherPreview} from "./crusher-visual.mjs";
import {drawFrequencyGraph} from "./graph.mjs";
import {mountDualThumb} from "./dual-thumb.mjs";
import {switchAudioRoute} from "./audio-route.mjs";
import {engineForInbandCurve} from "./engine-policy.mjs";
import {canExportChannels} from "./export-policy.mjs";
import {mapAtFrequency} from "./harmonics.mjs";
import {harmonicParameters,setFundamentalFromPivot,attachHarmonicPanel,renderHarmonicPanel,resolvedCarrierHz} from "./harmonics-panel.mjs";
import {defineParameter} from "./parameter-binding.mjs";
import {mountFrequencyUnitField} from "./frequency-unit-field.mjs";

const $=id=>document.querySelector(id);
const MAX_PREVIEW_SECONDS=600;
let graphMax=2000;
const controls={
  dry:$("#play-dry"),wet:$("#play-wet"),stop:$("#stop"),
  render:$("#render"),download:$("#download")
};
const dualControls={};
let lowUnitControl=null;
const state={
  ctx:null,decoded:null,dry:null,offline:null,offlineWorker:null,
  module:null,workletLoaded:false,player:null,position:0,seek:0,
  qualityIndex:0,settingsRevision:0,name:"audio",fileMeta:"音声未選択",processing:false,
  precise:Object.create(null),
  effective:{low:20,high:16000},raf:0,lastStats:null,mathCore:null,wasmPromise:null,rebuildTimer:null,sine:null,loadToken:0
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
const displayDigits=()=>Number($("#decimal-digits")?.value||3);
const displayNumber=value=>Number(value.toFixed(displayDigits())).toString();
const scalar=(name,fallback)=>name==="low"&&lowUnitControl?lowUnitControl.value:(state.precise[name]??fallback());
function showNumber(id,value){
  const field=$("#"+id);
  if(id==="low-value"&&lowUnitControl){lowUnitControl.refresh();return;}
  if(document.activeElement!==field&&Number.isFinite(value))field.value=displayNumber(value);
}
const fmtTime=seconds=>{
  const s=Math.max(0,seconds);
  return Math.floor(s/60)+":"+(s%60).toFixed(1).padStart(4,"0");
};
const duration=()=>state.dry?.length?state.dry[0].length/state.decoded.sampleRate:0;
function message(text,type="info"){$("#status").textContent=text;$("#status").dataset.kind=type;}
function indicator(text){$("#rt-indicator").textContent=text;}
function bounds(changed=""){
  const cap=state.decoded?Math.min(20000,state.decoded.sampleRate*.45):20000;
  let low=scalar("low",()=>hzFromScale($("#low").value));
  let high=Math.min(cap,scalar("high",()=>hzFromScale($("#high").value)));
  low=Math.min(low,cap/1.08);
  if(high<low*1.06){
    if(changed==="low")high=Math.min(cap,low*1.08);
    else low=Math.max(MIN_POSITIVE_HZ,high/1.08);
  }
  if(high<=low)low=Math.max(MIN_POSITIVE_HZ,high/1.08);
  $("#low").value=String(scaleFromHz(low));
  $("#high").value=String(scaleFromHz(high));
  low=Math.min(scalar("low",()=>hzFromScale($("#low").value)),cap/1.08);
  high=Math.min(scalar("high",()=>hzFromScale($("#high").value)),cap);
  if(low>=high)low=high/1.08;
  if(lowUnitControl&&!Object.is(lowUnitControl.value,low))lowUnitControl.setCanonical(low);
  state.effective={low,high};
  showNumber("low-value",low);
  showNumber("high-value",high);
  const rail=$("#dual-range");
  rail.style.setProperty("--lo",($("#low").value/10)+"%");
  rail.style.setProperty("--hi",($("#high").value/10)+"%");
  dualControls.bounds?.sync();
  return state.effective;
}
const isHarmonicPivotLinked=()=>$("#harmonic-pivot-link").checked;
function syncHarmonicToPivot(){
  const {F,m,r}=harmonicParameters(),H=r*F/m;
  state.precise["axis-pivot"]=H;
  $("#axis-pivot").value=String(scaleFromPivot(H));
  return H;
}
function syncPivotToHarmonic(){
  const P=scalar("axis-pivot",()=>pivotFromScale($("#axis-pivot").value));
  const result=setFundamentalFromPivot(P);
  if(!result)return;
  state.precise["axis-pivot"]=result.H;
  $("#axis-pivot").value=String(scaleFromPivot(result.H));
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
  $("#zero-reflect-formula").textContent="振幅="+displayNumber(100*p.zeroReflectGain)+
    "% × (1−"+displayNumber(p.zeroReflectDecay)+")^(反射点からの周波数距離/"+
    displayNumber(p.axisReference)+"Hz)。L/Hの折返し枝と0Hz越えの成分だけに適用。単なる周波数反転・負の傾きには適用しません。";
  showNumber("wet-value",100*p.wet);
  showNumber("axis-shift-value",p.axisShift);
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
  drawCrusherPreview($("#crusher-preview"),{bits:p.crusherBits,hold:p.crusherHold,sampleRate:p.sampleRate});
  const u=p.axisShift,ref=p.axisReference;
  $("#axis-mode-hint").textContent=p.invert>0?"反転も適用中":"";
  const modeCode=p.mode==="blend"?1:p.mode==="fold-l"?2:p.mode==="reciprocal"?3:0;
  const hz=state.mathCore?.warp_invert_reference_frequency?.(p.low,p.high,p.curvature,p.invert,modeCode);
  $("#invert-reference-hz").textContent=p.mode==="blend"?"反転 "+displayNumber(p.invert*100)+"%":
    (p.mode==="reciprocal"?"反転固定点 ":p.mode==="fold-l"?"L折返し ":"H折返し ")+
    (Number.isFinite(hz)?displayNumber(hz)+" Hz":"—");
  const pText=displayNumber(p.curvature);
  $("#curvature-log-formula").textContent="p="+pText+" · S₀(f)=ln(f/L)、Sₚ(f)=((f/L)ᵖ−1)/p (p>0)。移動量は p=0: f×eᵘ、p=1: f+uR Hz（他の傾き/起点設定は別）。";
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
  $("#graph-log-formula").textContent="α="+displayNumber(alpha)+" · x(f)=(1−α)×f/"+graphMax+"+α×ln(1+f/20)/ln(1+"+graphMax+"/20)。x/y共通の0Hzを含む表示尺度（音声DSPに影響しません）。";
  const isCrushed=p.crusherBits>0&&(p.crusherHold>1||p.crusherHold===0);
  $("#crusher-alias-legend").hidden=!isCrushed;
  $("#crusher-alias-note").hidden=p.crusherBits===0;
  if(p.crusherBits>0)$("#crusher-alias-note").textContent=p.crusherHold===0?
    "更新 0 Hz：開始値を保持。出力はDCのみで元周波数の周期音は消えます。":
    (p.crusherHold===1?"間引き無し。振幅量子化による追加倍音は入力音の振幅・位相に依存します。":
    "実効更新 "+displayNumber(p.sampleRate/p.crusherHold)+" Hz。y="+displayNumber(p.sampleRate/p.crusherHold/2)+" Hzは実効ナイキスト折返し境界。実線＝単一正弦波の標本保持から生じる理論スペクトル像、透明度＝理想応答ゲイン（振幅量子化でさらに変化）。");
  updateListeningGuide();
  $("#graph-title").textContent=graphMax===2000?"〜2kHz":"〜20kHz";
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
function refreshPlayhead(){
  const seconds=playPosition();
  $("#elapsed").textContent=fmtTime(seconds);
  $("#duration").textContent=fmtTime(duration());
  $("#playhead").style.left=(duration()?clamp(seconds/duration(),0,1)*100:0)+"%";
  state.raf=requestAnimationFrame(refreshPlayhead);
}
function playheadFromPointer(e){
  if(!state.dry)return;
  const rect=$("#wave").getBoundingClientRect();
  const frac=clamp((e.clientX-rect.left)/rect.width,0,.999999);
  state.seek=frac*duration();
  if(state.player){
    seek(state.seek);
  }else{
    play("wet",state.seek).catch(err=>message("再生失敗: "+err.message,"error"));
  }
  refreshStatusSeek();
}
function refreshStatusSeek(){
  $("#elapsed").textContent=fmtTime(state.seek);
  $("#playhead").style.left=(duration()?100*state.seek/duration():0)+"%";
}
$("#wave").addEventListener("pointerdown",playheadFromPointer);
$("#wave").addEventListener("keydown",e=>{
  if(!state.dry)return;
  if(e.key==="Enter"||e.key===" "){
    e.preventDefault();play("wet",state.seek).catch(err=>message(err.message,"error"));
  }else if(e.key==="ArrowLeft"||e.key==="ArrowRight"){
    e.preventDefault();const diff=e.key==="ArrowLeft"?-2:2;
    const pos=clamp(playPosition()+diff,0,Math.max(0,duration()-.01));
    state.seek=pos;
    if(state.player)seek(pos);
    refreshStatusSeek();
  }
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
  if(!p)return;
  const now=state.ctx.currentTime,wet=p.mode==="wet"?settings().wet:0;
  p.wet.gain.setTargetAtTime(wet,now,.012);
  p.dry.gain.setTargetAtTime(1-wet,now,.012);
}
function playerMessage(node,p){
  return ({data})=>{
    if(state.player!==p)return;
    if(data.type==="error")message("共通DSP: "+data.message,"error");
    if(data.type==="parameters-applied"){
      p.appliedRevision=data.revision;
      indicator("稼働中 · Rust/WASM 128 samples/block · 操作反映済み");
    }
    if(data.type==="stats"){
      state.lastStats=data;
      const wet=Number(data.outputRms)||0,dry=Number(data.inputRms)||0;
      $("#signal-diagnostic").textContent=dry>.002&&wet<dry*.01?
        "⚠ 変換音が小さい":wet>0.003?"変換音：出力中":"再生中";
      $("#signal-diagnostic").title="入力 "+dry.toFixed(3)+" / 変換 "+wet.toFixed(3)+" RMS";
      $("#signal-diagnostic").dataset.silent=dry>.002&&wet<dry*.01?"yes":"no";
      const latency=1000*data.latencyFrames/state.ctx.sampleRate;
      indicator("リアルタイム動作中 · DSP遅延 "+latency.toFixed(1)+" ms · 約 "+
        data.averageBlockMs.toFixed(2)+" ms/block / 予算超過 "+data.overBudgetBlocks);
    }
  };
}
function startSource(p,offset){
  if(p.source){try{p.source.stop();}catch{}p.source.disconnect();}
  p.worklet.port.postMessage({type:"reset"});
  const src=state.ctx.createBufferSource();
  src.buffer=p.buffer;src.loop=true;src.connect(p.worklet);
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
    element.onpause=fallback;
    element.onwaiting=fallback;
    element.onstalled=fallback;
    element.onerror=fallback;
    element.onplaying=()=>{
      if(state.player===player)switchAudioRoute(player,state.ctx,true);
    };
    await element.play();
    if(state.player!==player){element.pause();return;}
    if(!element.paused)switchAudioRoute(player,state.ctx,true);
    player.mediaBridge=node;
  }catch{
    switchAudioRoute(player,state.ctx,false);
    try{player.bridgeRoute?.disconnect();}catch{}
    player.bridgeRoute=null;
    try{element.pause();element.srcObject=null;}catch{}
  }
}
async function stop(){
  const p=state.player;
  if(!p){controls.stop.disabled=true;mediaStatus(false);return;}
  state.seek=playPosition();
  state.player=null;
  try{p.source?.stop();}catch{}
  try{p.source?.disconnect();p.worklet.disconnect();p.wet.disconnect();
    p.dry.disconnect();p.master.disconnect();p.directRoute.disconnect();
    p.bridgeRoute?.disconnect();}catch{}
  try{p.worklet.port.postMessage({type:"dispose"});}catch{}
  try{const el=$("#background-output");el.pause();el.srcObject=null;}catch{}
  mediaStatus(false);
  p.worklet.port.onmessage=null;
  controls.stop.disabled=true;
  indicator("停止中 · Rust / WASM AudioWorklet");
  refreshStatusSeek();
}
async function play(mode="wet",offset=null){
  if(!state.dry)return;
  if(state.player){
    if(offset!==null)seek(offset);
    state.player.mode=mode;
    tuneWet();
    message(mode==="wet"?"リアルタイム音声処理中。パラメータは即時適用されます。":"原音を連続再生中。");
    return;
  }
  controls.dry.disabled=true;controls.wet.disabled=true;
  indicator("共通Rust/WASM DSPの起動中…");
  try{
    const {ctx,module}=await prepareCore();
    const current=settings();
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
      offset:0,appliedRevision:0
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
    if(state.player!==player)return;
    tuneWet();
    controls.stop.disabled=false;
    indicator("稼働中 · Rust/WASM AudioWorklet · "+(1000*result.latencyFrames/ctx.sampleRate).toFixed(1)+" ms DSP遅延");
    message(mode==="wet"?"128サンプル単位でリアルタイム変換中。ツマミ操作で曲全体を再計算しません。":"原音再生中。");
  }catch(error){
    await stop();
    message("再生準備失敗: "+error.message,"error");
    indicator("起動失敗");
  }finally{
    controls.dry.disabled=!state.dry;
    controls.wet.disabled=!state.dry;
  }
}
function updateParams(changed){
  labels(changed);drawCurve();renderHarmonicPanel(foldPoint,axisMarker,settings);
  state.offline=null;controls.download.disabled=true;
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
  const current=settings();
  if(current.qualityIndex!==p.quality||current.hopDiv!==p.hopDiv||current.engine!==p.engine){
    // Debounce costly stream rebuilds while the user is selecting; keep
    // current playback position rather than stopping on every input event.
    if(state.rebuildTimer)clearTimeout(state.rebuildTimer);
    state.rebuildTimer=setTimeout(async()=>{
      state.rebuildTimer=null;
      const active=state.player;if(!active)return;
      const offset=playPosition(),mode=active.mode;
      await stop();await play(mode,offset);
    },180);
    indicator("設定を反映するため音声処理を切替中…");
    return;
  }
  // A rapid switch A→B→A (or FFT selection rollback) must not leave a
  // pending rebuild after the current processor already matches settings.
  if(state.rebuildTimer){clearTimeout(state.rebuildTimer);state.rebuildTimer=null;}
  const revision=++state.settingsRevision;
  p.worklet.port.postMessage({
    type:"params",settings:current,activeQualityIndex:p.quality,revision
  });
  indicator("リアルタイム動作中 · パラメータ更新中…");
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
  field:$("#low-value"),select:$("#low-unit"),snapToggle:$("#low-snap"),
  slider:$("#low"),railRoot:$("#dual-range"),
  getDigits:displayDigits,
  initialValue:hzFromScale($("#low").value),
  onValueChange:()=>{updateParams("low");updateEngineInfo();}
});
// Other controls retain the legacy input binding until their own M1/M2
// migrations are accepted. There is no duplicated canonical value for low.
const inline={
  "a-min-value":["a-min",v=>scaleFromHz(v),"a-min",MIN_POSITIVE_HZ,20000],
  "a-band-value":["a-band",v=>v,"a-band",1,8],
  "a-quality-value":["a-quality",v=>v,"a-quality",0,100],
  "a-reverb-value":["a-reverb",v=>v,"a-reverb",0,100],
  "high-value":["high",v=>scaleFromHz(v),"high",MIN_POSITIVE_HZ,20000],
  "axis-pivot-value":["axis-pivot",v=>scaleFromPivot(v),"axis-pivot",0,20000],
  "invert-value":["invert",v=>v/100,"invert",0,100],
  "zero-reflect-value":["zero-reflect",v=>v,"zero-reflect",0,100],
  "zero-decay-value":["zero-decay",v=>v,"zero-decay",0,100],
  "curvature-value":["curvature",v=>v,"curvature",0,1],
  "axis-shift-value":["axis-shift",v=>v,"axis-shift",-2,2],
  "axis-slope-value":["axis-slope",v=>v,"axis-slope",-4,4],
  "wet-value":["wet",v=>v/100,"wet",0,100],
  "crusher-bits-value":["crusher-bits",v=>v,"crusher-bits",2,16],
  "crusher-hold-value":["crusher-hold",v=>sliderFromFrequency(v,state.ctx?.sampleRate||state.decoded?.sampleRate||48000),"crusher-hold",0,192000]
};
for(const [id,[range,convert,changed,min,max]] of Object.entries(inline)){
  const field=$("#"+id);
  const integer=range==="crusher-bits"||range==="a-band"||range==="a-quality";
  const normalized=value=>{
    const v=clamp(value,min,max);
    return integer?Math.round(v):round3(v);
  };
  const toDsp=value=>range==="invert"||range==="zero-reflect"||range==="zero-decay"||range==="wet"||range==="a-reverb"?
    value/100:normalized(value);
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
    if(range==="wet"){labels();tuneWet();drawCurve();}
    else {updateParams(changed);updateEngineInfo();}
  };
  field.addEventListener("focus",()=>{
    if(state.precise[range]!==undefined){
      const number=state.precise[range];
      const typed=range==="invert"||range==="zero-reflect"||range==="zero-decay"||range==="wet"||range==="a-reverb"?
        number*100:number;
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
    const human=range==="invert"||range==="zero-reflect"||range==="zero-decay"||range==="wet"||range==="a-reverb"?native*100:native;
    if(Number.isFinite(human))showNumber(id,human);
  });
  field.addEventListener("keydown",event=>{if(event.key==="Enter")field.blur();});
}
// Compact shared rails. Actual parameter updates still use the same
// source ranges and existing native Rust AudioWorklet/WAV bindings.
dualControls.bounds=mountDualThumb($("#dual-range"),["low","high"],[
  v=>hzText(hzFromScale(v)),v=>hzText(hzFromScale(v))
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
$("#curve").addEventListener("click",()=>{graphMax=graphMax===2000?20000:2000;drawCurve();});
$("#curve").addEventListener("keydown",event=>{
  if(event.key==="Enter"||event.key===" "){event.preventDefault();graphMax=graphMax===2000?20000:2000;drawCurve();}
});
for(const name of ["low","high","curvature","invert","zero-reflect","zero-decay","axis-shift","axis-pivot","axis-slope","a-min","a-band","a-quality","a-reverb","ring-enabled","rational-enabled"]){
  $("#"+name).addEventListener("input",()=>{
    if(name==="low"){lowUnitControl.fromSlider();return;}
    delete state.precise[name];
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
$("#decimal-digits").addEventListener("change",()=>{
  labels();drawCurve();renderHarmonicPanel(foldPoint,axisMarker,settings);
  lowUnitControl.refresh();
  updateSineLabel();
});
$("#wet").addEventListener("input",()=>{delete state.precise.wet;labels();tuneWet();drawCurve();});
$("#slope-one").addEventListener("click",()=>{
  delete state.precise["axis-slope"];
  $("#axis-slope").value="1";
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
controls.stop.addEventListener("click",()=>stop());
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
  // No AudioContext.resume(): playback still requires the later user gesture.
  let firstFailure=null;
  if(typeof OfflineAudioContext!=="undefined"){
    try{
      message("音声を解析中…");
      const buffer=await withDecodeDeadline(file.arrayBuffer(),10000,"ファイル読み込み");
      if(token!==state.loadToken)return null;
      const offline=new OfflineAudioContext(1,1,44100);
      return await withDecodeDeadline(offline.decodeAudioData(buffer),6500,"初回デコード");
    }catch(error){firstFailure=error;}
  }
  if(token!==state.loadToken)return null;
  message("別の読み込み方法に切り替えています…");
  const Constructor=window.AudioContext||window.webkitAudioContext;
  if(!Constructor)throw Error("このブラウザでは音声ファイルを解析できません");
  let ctx,owned=false;
  try{
    // Create a decode-only context. decodeAudioData is allowed while it is
    // suspended: do not await resume() and lose the picker gesture on iOS.
    try{ctx=new Constructor();owned=true;}
    catch(error){if(state.ctx)ctx=state.ctx;else throw error;}
    const bytes=await withDecodeDeadline(file.arrayBuffer(),12000,"再読み込み");
    if(token!==state.loadToken)return null;
    return await withDecodeDeadline(ctx.decodeAudioData(bytes),16000,"代替デコード");
  }catch(error){
    throw Error((firstFailure?firstFailure.message+"。":"")+"代替経路も失敗: "+error.message);
  }finally{
    if(owned&&ctx?.close)void ctx.close().catch(()=>{});
  }
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
    state.offline=null;state.decoded={sampleRate:data.sampleRate};
    state.dry=dry;state.seek=0;state.lastStats=null;
    state.name=file.name.replace(/\.[^.]+$/,"");
    mediaStatus(false);
    state.fileMeta=file.name+" · "+duration().toFixed(1)+"秒 · "+data.sampleRate+"Hz · "+count+"ch";
    $("#file-meta").textContent=state.fileMeta;
    labels("high");drawCurve();drawAudio();refreshStatusSeek();
    controls.dry.disabled=false;controls.wet.disabled=false;
    controls.stop.disabled=true;
    controls.render.disabled=false;controls.download.disabled=true;
    $("#progress").value=0;
    message("読み込み完了。再生できます。");
  }catch(error){
    if(token!==state.loadToken)return;
    $("#file-meta").textContent=previousReady?state.fileMeta:"読み込み失敗（ファイルを選び直せます）";
    message("音声を開けませんでした: "+error.message+
      (previousReady?"。以前の音声は保持しています。":""),"error");
  }
}

$("#audio-file").addEventListener("change",e=>{const file=e.target.files[0];e.target.value="";void load(file);});
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
  state.offline=null;controls.download.disabled=true;controls.render.disabled=true;
  $("#progress").value=0;message("WAV書出し用オフライン処理中（試聴とは独立）…");
  const renderSettings=settings();
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
      message("オフライン書出し用の変換が完了しました。");
    }else if(data.type==="error"){
      controls.render.disabled=false;worker.terminate();state.offlineWorker=null;
      message("オフライン書出し失敗: "+data.message,"error");
    }
  };
  worker.onerror=e=>{
    if(state.offlineWorker!==worker)return;
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
  const mixed=state.offline.map((ch,i)=>mixWet(state.dry[i],ch,settings().wet));
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
    low:"200",high:"974",curvature:"1",invert:"0",wet:"1","axis-shift":"0","axis-pivot":"532","axis-slope":"1",
    engine:"1",mode:"reciprocal",outside:"pass",quality:"eco",
    overlap:"4","zero-reflect":"100","zero-decay":"0","harmonic-count":"5","decimal-digits":"3","graph-log":"100","a-band":"1","a-quality":"0"
  };
  state.precise=Object.create(null);
  lowUnitControl.reset();
  for(const [id,value] of Object.entries(defaults))$("#"+id).value=value;
  $("#ring-enabled").checked=false;$("#rational-enabled").checked=false;
  $("#harmonic-pivot-link").checked=false;
  $("#engine-auto").checked=false;
  $("#a-min").value="200";$("#a-reverb").value="0";
  $("#a-min-value").value="20";$("#a-reverb-value").value="0";$("#a-band-value").value="1";$("#a-quality-value").value="0";
  $("#crusher-enabled").checked=false;
  $("#crusher-bits").value="8";$("#crusher-hold").value="880";
  $("#crusher-bits-value").value="8";
  $("#crusher-hold-value").value="12000";
  labels();tuneWet();updateParams("settings-reset");updateEngineInfo();
  message("エフェクト設定を初期値へ戻しました。再生位置は保持されます。");
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
$("#mini-expand").addEventListener("click",()=>showTab("math"));
for(const [node,tab] of [["#tab-map","map"],["#tab-math","math"]]){
  $(node).addEventListener("keydown",e=>{
    if(e.key!=="ArrowLeft"&&e.key!=="ArrowRight")return;
    e.preventDefault();const next=tab==="map"?"math":"map";
    showTab(next);$("#tab-"+next).focus();
  });
}
// WebAudio reference sine is a monitoring aid, not a competing DSP engine.
const NOTE_NAMES=["C","C♯","D","D♯","E","F","F♯","G","G♯","A","A♯","B"];
const sinePitch=()=>state.sineExactPitch??Number($("#sine-pitch").value);
const sineFrequency=()=>440*2**((sinePitch()-69)/12);
function updateSineLabel(){
  const value=sinePitch(),nearest=Math.round(value);
  const note=NOTE_NAMES[((nearest%12)+12)%12]+(Math.floor(nearest/12)-1);
  const cents=round3((value-nearest)*100);
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
$("#sine-pitch").addEventListener("input",()=>{delete state.sineExactPitch;updateSineLabel();});
$("#sine-hz").addEventListener("input",()=>{
  const raw=Number($("#sine-hz").value);
  if(!Number.isFinite(raw)||$("#sine-hz").value==="")return;
  const hz=round3(clamp(raw,65,2100));
  state.sineExactPitch=clamp(69+12*Math.log2(hz/440),36,96);
  $("#sine-pitch").value=String(state.sineExactPitch);
  updateSineLabel();
});
$("#sine-hz").addEventListener("focus",()=>{
  $("#sine-hz").value=String(round3(sineFrequency()));$("#sine-hz").select();
});
$("#sine-hz").addEventListener("blur",()=>{
  showNumber("sine-hz",sineFrequency());
});
$("#sine-cent").addEventListener("input",()=>{
  if($("#sine-cent").value==="")return;
  const cents=round3(clamp(Number($("#sine-cent").value),-50,50));
  if(!Number.isFinite(cents))return;
  const root=Math.round(sinePitch());
  state.sineExactPitch=clamp(root+cents/100,36,96);
  $("#sine-pitch").value=String(state.sineExactPitch);
  updateSineLabel();
});
$("#sine-cent").addEventListener("focus",()=>{$("#sine-cent").value=String(round3((sinePitch()-Math.round(sinePitch()))*100));});
$("#sine-cent").addEventListener("blur",()=>showNumber("sine-cent",(sinePitch()-Math.round(sinePitch()))*100));
$("#sine-enabled").addEventListener("change",async()=>{
  if(!$("#sine-enabled").checked){stopSine();return;}
  try{
    const ctx=await context();
    if(!$("#sine-enabled").checked)return;
    stopSine();
    const osc=ctx.createOscillator(),gain=ctx.createGain();
    osc.type="sine";osc.frequency.value=sineFrequency();
    gain.gain.value=0.08;
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
  if(isHarmonicPivotLinked())syncHarmonicToPivot();
  updateParams("harmonic-pivot-link");updateEngineInfo();
});
attachHarmonicPanel(id=>{
  if(isHarmonicPivotLinked()&&["fundamental","denominator","pitch-ratio"].includes(id)){
    syncHarmonicToPivot();
  }
  updateParams(id);updateEngineInfo();
},foldPoint,axisMarker,settings);
labels();drawCurve();updateEngineInfo();refreshPlayhead();
ensureSharedCore().catch(()=>{});
// Set only after all interactive controls have registered successfully.
document.documentElement.dataset.fwBoot="ready";
