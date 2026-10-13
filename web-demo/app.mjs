import {QUALITY,mixWet} from "./dsp.mjs";
import {drawFrequencyGraph} from "./graph.mjs";
import {mapAtFrequency} from "./harmonics.mjs";
import {harmonicParameters,attachHarmonicPanel,renderHarmonicPanel,resolvedCarrierHz} from "./harmonics-panel.mjs";

const $=id=>document.querySelector(id);
const MAX_PREVIEW_SECONDS=600;
let graphMax=2000;
const controls={
  dry:$("#play-dry"),wet:$("#play-wet"),stop:$("#stop"),
  render:$("#render"),download:$("#download")
};
const state={
  ctx:null,decoded:null,dry:null,offline:null,offlineWorker:null,
  module:null,workletLoaded:false,player:null,position:0,seek:0,
  qualityIndex:0,settingsRevision:0,name:"audio",processing:false,
  precise:Object.create(null),
  effective:{low:20,high:16000},raf:0,lastStats:null,mathCore:null,wasmPromise:null,rebuildTimer:null,sine:null,loadToken:0
};
const hzFromScale=value=>20*Math.exp(Math.log(1000)*Number(value)/1000);
const pivotFromScale=value=>Number(value)<=0?0:20*Math.exp(Math.log(1000)*(Number(value)-1)/999);
const scaleFromPivot=hz=>hz<=0?0:1+Math.round(999*Math.log(Math.max(20,hz)/20)/Math.log(1000));
const scaleFromHz=hz=>Math.round(1000*Math.log(Math.max(20,hz)/20)/Math.log(1000));
const hzText=hz=>hz>=1000?(hz/1000).toFixed(hz>=10000?1:2)+" kHz":Math.round(hz)+" Hz";
const clamp=(x,a,b)=>Math.max(a,Math.min(b,x));
const round3=value=>Math.round((value+Number.EPSILON)*1000)/1000;
const view2=value=>Number(value.toFixed(2)).toString();
const scalar=(name,fallback)=>state.precise[name]??fallback();
function showNumber(id,value){
  const field=$("#"+id);
  if(document.activeElement!==field&&Number.isFinite(value))field.value=view2(value);
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
    else low=Math.max(20,high/1.08);
  }
  if(high<=low)low=Math.max(20,high/1.08);
  $("#low").value=String(scaleFromHz(low));
  $("#high").value=String(scaleFromHz(high));
  low=Math.min(scalar("low",()=>hzFromScale($("#low").value)),cap/1.08);
  high=Math.min(scalar("high",()=>hzFromScale($("#high").value)),cap);
  if(low>=high)low=high/1.08;
  state.effective={low,high};
  showNumber("low-value",low);
  showNumber("high-value",high);
  const rail=$("#dual-range");
  rail.style.setProperty("--lo",($("#low").value/10)+"%");
  rail.style.setProperty("--hi",($("#high").value/10)+"%");
  return state.effective;
}
function settings(){
  const {low,high}=bounds();
  const qualityIndex=({eco:0,standard:1,high:2}[$("#quality").value]);
  return {
    low,high,curvature:scalar("curvature",()=>Number($("#curvature").value)),
    invert:scalar("invert",()=>Number($("#invert").value)),
    mode:$("#mode").value,outside:$("#outside").value,qualityIndex,
    engine:Number($("#engine").value),hopDiv:Number($("#overlap").value),
    pitchRatio:harmonicParameters().r,
    shiftHz:harmonicParameters().n*harmonicParameters().r*harmonicParameters().F/harmonicParameters().m,
    carrierHz:harmonicParameters().c,zeroMode:harmonicParameters().zeroMode,
    axisShift:scalar("axis-shift",()=>Number($("#axis-shift").value)),
    axisReference:harmonicParameters().r*harmonicParameters().F,
    axisPivot:scalar("axis-pivot",()=>pivotFromScale($("#axis-pivot").value)),
    axisSlope:scalar("axis-slope",()=>Number($("#axis-slope").value)),
    sampleRate:state.ctx?.sampleRate||state.decoded?.sampleRate||48000,
    wet:scalar("wet",()=>Number($("#wet").value)),
    ringEnabled:$("#ring-enabled").checked,
    rationalEnabled:$("#rational-enabled").checked,
    crusherBits:$("#crusher-enabled").checked?scalar("crusher-bits",()=>Number($("#crusher-bits").value)):0,
    crusherHold:scalar("crusher-hold",()=>Number($("#crusher-hold").value)),
    aMinHz:scalar("a-min",()=>hzFromScale($("#a-min").value)),
    aReverb:scalar("a-reverb",()=>Number($("#a-reverb").value)/100)
  };
}
function labels(id=""){
  bounds(id);
  const p=settings();
  showNumber("curvature-value",p.curvature);
  showNumber("axis-pivot-value",p.axisPivot);
  showNumber("axis-slope-value",p.axisSlope);
  showNumber("invert-value",100*p.invert);
  showNumber("wet-value",100*p.wet);
  showNumber("axis-shift-value",p.axisShift);
  showNumber("a-min-value",p.aMinHz);
  showNumber("a-reverb-value",100*p.aReverb);
  showNumber("crusher-bits-value",p.crusherBits||Number($("#crusher-bits").value));
  showNumber("crusher-hold-value",p.crusherHold);
  const u=p.axisShift,ref=p.axisReference;
  $("#axis-mode-hint").textContent=p.invert>0?"反転も適用中":"";
  $("#axis-explainer").textContent=p.curvature===0?
    "移動倍率 ×"+Math.exp(u).toFixed(2):p.curvature===1?
    "移動 "+Math.round(u*ref)+" Hz":"移動：中間尺度";
}

function foldPoint(){
  const core=state.mathCore;
  if(!core)return NaN;
  const p=settings();
  return core.warp_fold_frequency(p.low,p.high,p.curvature,p.invert,
    p.mode==="blend"?1:p.mode==="fold-l"?2:0);
}
function axisMarker(f){
  const core=state.mathCore;
  if(!core||!(f>0))return NaN;
  const p=settings();
  const {warp,translate}=mathCallbacks();
  const result=mapAtFrequency(f,p,warp,translate);
  return result.raw??NaN;
}
function mathCallbacks(){
  const core=state.mathCore,reference=settings().axisReference;
  return {
    warp:(f,l,h,curvature,invert,mode)=>
      core.warp_map_frequency(f,l,h,curvature,invert,mode==="blend"?1:mode==="fold-l"?2:0),
    translate:(f,pivot,curvature,shift,slope,anchor)=>
      core.warp_translate_frequency_anchored(f,anchor,pivot,slope,reference,curvature,shift)
  };
}
function updateListeningGuide(){
  if(!state.mathCore)return;
  const p=settings(),{warp,translate}=mathCallbacks();
  const pivot=Math.max(20,p.axisPivot);
  const input=500,point=mapAtFrequency(input,p,warp,translate);
  const output=point.outputs[0];
  const diff=Number.isFinite(output)?12*Math.log2(output/input):NaN;
  const hz=n=>Number.isFinite(n)?(Math.round(n*10)/10)+"Hz":"—";
  const effect=Number.isFinite(diff)?(diff>=0?"+":"")+diff.toFixed(1)+"半音":"範囲外";
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
  const shown={...p,carrierHz:resolvedCarrierHz(foldPoint)};
  const {warp,translate}=mathCallbacks();
  drawFrequencyGraph(canvas,shown,warp,translate,graphMax);
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
        typeof core.warp_translate_frequency_anchored!=="function")throw Error("共通数式APIがありません");
      state.module=bytes;state.mathCore=core;
      drawCurve();renderHarmonicPanel(foldPoint,axisMarker);
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
  $("#engine-a-settings").hidden=s.engine!==0;
  $("#engine-description").textContent=explain[s.engine]+
    (s.ringEnabled?" / Ring Mod ON":"")+(s.rationalEnabled?" / #24倍音配置 ON":"");
  $("#engine-summary").textContent=names[s.engine];
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
    player.master.connect(node);
    element.srcObject=node.stream;
    await element.play();
    if(state.player!==player){element.pause();return;}
    player.master.disconnect(state.ctx.destination);
    player.mediaBridge=node;
  }catch{
    try{if(node)player.master.disconnect(node);}catch{}
    try{element.pause();element.srcObject=null;}catch{}
  }
}
async function stop(){
  const p=state.player;
  if(!p){controls.stop.disabled=true;mediaStatus(false);return;}
  state.seek=playPosition();
  state.player=null;
  try{p.source?.stop();}catch{}
  try{p.source?.disconnect();p.worklet.disconnect();p.wet.disconnect();p.dry.disconnect();p.master.disconnect();}catch{}
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
    dry.connect(master);wet.connect(master);master.connect(ctx.destination);
    master.gain.value=1;
    const player={
      worklet,dry,wet,master,buffer:makeBuffer(),source:null,
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
  labels(changed);drawCurve();renderHarmonicPanel(foldPoint,axisMarker);
  state.offline=null;controls.download.disabled=true;
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
  const revision=++state.settingsRevision;
  p.worklet.port.postMessage({
    type:"params",settings:current,activeQualityIndex:p.quality,revision
  });
  indicator("リアルタイム動作中 · パラメータ更新中…");
}
// Value fields are the readout themselves. Editing one immediately moves its slider.
const inline={
  "a-min-value":["a-min",v=>scaleFromHz(v),"a-min",20,20000],
  "a-reverb-value":["a-reverb",v=>v,"a-reverb",0,100],
  "low-value":["low",v=>scaleFromHz(v),"low",20,20000],
  "high-value":["high",v=>scaleFromHz(v),"high",20,20000],
  "axis-pivot-value":["axis-pivot",v=>scaleFromPivot(v),"axis-pivot",0,20000],
  "invert-value":["invert",v=>v/100,"invert",0,100],
  "curvature-value":["curvature",v=>v,"curvature",0,1],
  "axis-shift-value":["axis-shift",v=>v,"axis-shift",-2,2],
  "axis-slope-value":["axis-slope",v=>v,"axis-slope",0.1,4],
  "wet-value":["wet",v=>v/100,"wet",0,100],
  "crusher-bits-value":["crusher-bits",v=>v,"crusher-bits",2,16],
  "crusher-hold-value":["crusher-hold",v=>v,"crusher-hold",1,32]
};
for(const [id,[range,convert,changed,min,max]] of Object.entries(inline)){
  const field=$("#"+id);
  const integer=range==="crusher-bits"||range==="crusher-hold";
  const normalized=value=>{
    const v=clamp(value,min,max);
    return integer?Math.round(v):round3(v);
  };
  const toDsp=value=>range==="invert"||range==="wet"||range==="a-reverb"?
    round3(value/100):normalized(value);
  const apply=()=>{
    if(field.value.trim()==="")return;
    const raw=Number(field.value);
    if(!Number.isFinite(raw))return;
    const value=normalized(raw);
    // Slider is only a coarse visual/gesture proxy. The exact value is
    // kept separately and sent to Rust instead of reading snapped range.value.
    state.precise[range]=toDsp(value);
    $("#"+range).value=String(convert(value));
    if(range==="wet"){labels();tuneWet();drawCurve();}
    else {updateParams(changed);updateEngineInfo();}
  };
  field.addEventListener("focus",()=>{
    if(state.precise[range]!==undefined){
      const number=state.precise[range];
      const typed=range==="invert"||range==="wet"||range==="a-reverb"?
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
    const human=range==="invert"||range==="wet"||range==="a-reverb"?native*100:native;
    if(Number.isFinite(human))showNumber(id,human);
  });
  field.addEventListener("keydown",event=>{if(event.key==="Enter")field.blur();});
}
// The two handles share a physical track. Touching the bare rail selects
// whichever endpoint is closest; the handles themselves remain draggable.
$("#dual-range").addEventListener("pointerdown",event=>{
  if(event.target!==$("#dual-range"))return;
  const box=event.currentTarget.getBoundingClientRect();
  const normalized=clamp((event.clientX-box.left)/box.width,0,1);
  const target=normalized*1000;
  const low=Number($("#low").value),high=Number($("#high").value);
  const slider=Math.abs(target-low)<=Math.abs(target-high)?$("#low"):$("#high");
  slider.value=String(Math.round(target));
  slider.dispatchEvent(new Event("input",{bubbles:true}));
});
$("#curve").addEventListener("click",()=>{graphMax=graphMax===2000?20000:2000;drawCurve();});
$("#curve").addEventListener("keydown",event=>{
  if(event.key==="Enter"||event.key===" "){event.preventDefault();graphMax=graphMax===2000?20000:2000;drawCurve();}
});
for(const name of ["low","high","curvature","invert","axis-shift","axis-pivot","axis-slope","mode","outside","quality","overlap","engine","a-min","a-reverb","ring-enabled","rational-enabled"]){
  $("#"+name).addEventListener("input",()=>{delete state.precise[name];updateParams(name);updateEngineInfo();});
}
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
    $("#crusher-hold-value").value=$("#crusher-hold").value;
    updateParams(id);updateEngineInfo();
  });
}

controls.dry.addEventListener("click",()=>play("dry"));
controls.wet.addEventListener("click",()=>play("wet"));
controls.stop.addEventListener("click",()=>stop());
window.addEventListener("resize",()=>{drawCurve();drawAudio();});
window.addEventListener("pagehide",()=>{if(state.rebuildTimer)clearTimeout(state.rebuildTimer);stop();if(state.offlineWorker)state.offlineWorker.terminate();});
// Decoding must NOT wait on AudioContext.resume(): after the iOS file
// picker closes the resume promise can remain pending until another gesture.
// OfflineAudioContext decodes independently of the real-time output lifecycle.
async function decodeFileWithoutPlayback(file,token){
  if(typeof OfflineAudioContext==="undefined"){
    throw Error("このブラウザで音声の読み込みは利用できません");
  }
  const bytes=await file.arrayBuffer();
  if(token!==state.loadToken)return null;
  message("音声を解析中…");
  const decoder=new OfflineAudioContext(1,1,44100);
  let timer;
  try{
    const timeout=new Promise((_,reject)=>{
      timer=setTimeout(()=>reject(Error("読み込みが時間切れです。もう一度ファイルを選んでください")),45000);
    });
    return await Promise.race([decoder.decodeAudioData(bytes),timeout]);
  }finally{clearTimeout(timer);}
}
async function load(file){
  if(!file)return;
  const token=++state.loadToken;
  try{
    await stop();
    if(token!==state.loadToken)return;
    if(state.offlineWorker){state.offlineWorker.terminate();state.offlineWorker=null;}
    state.offline=null;state.decoded=null;state.dry=null;state.seek=0;
    for(const node of [controls.dry,controls.wet,controls.render,controls.download])node.disabled=true;
    if(file.size>75_000_000)throw Error("最大75MBです");
    $("#file-meta").textContent=file.name+" · 読み込み中";
    message("音声を開いています…");
    const data=await decodeFileWithoutPlayback(file,token);
    if(token!==state.loadToken||!data)return;
    const count=Math.min(2,data.numberOfChannels);
    const length=Math.min(data.length,Math.floor(data.sampleRate*MAX_PREVIEW_SECONDS));
    if(length<4096)throw Error("短すぎる音声です");
    const dry=Array.from({length:count},(_,i)=>data.getChannelData(i).slice(0,length));
    if(token!==state.loadToken)return;
    state.dry=dry;state.decoded={sampleRate:data.sampleRate};
    state.name=file.name.replace(/\.[^.]+$/,"");
    mediaStatus(false);
    $("#file-meta").textContent=file.name+" · "+duration().toFixed(1)+"秒 · "+data.sampleRate+"Hz · "+count+"ch";
    labels("high");drawCurve();drawAudio();refreshStatusSeek();
    controls.dry.disabled=false;controls.wet.disabled=false;controls.render.disabled=false;
    message("読み込み完了。再生できます。");
  }catch(error){
    if(token!==state.loadToken)return;
    $("#file-meta").textContent="読み込み失敗（ファイルを選び直せます）";
    message("音声を開けませんでした: "+error.message,"error");
  }
}

$("#audio-file").addEventListener("change",e=>{const file=e.target.files[0];e.target.value="";void load(file);});
const drop=$("#drop");
drop.addEventListener("click",e=>{if(e.target.id!=="audio-file")$("#audio-file").click();});
drop.addEventListener("keydown",e=>{
  if(e.key==="Enter"||e.key===" "){e.preventDefault();$("#audio-file").click();}
});
drop.addEventListener("dragover",e=>{e.preventDefault();drop.classList.add("hover");});
drop.addEventListener("dragleave",()=>drop.classList.remove("hover"));
drop.addEventListener("drop",e=>{e.preventDefault();drop.classList.remove("hover");load(e.dataTransfer.files[0]);});

// WAV export deliberately stays OFFLINE; not required by live playback.
controls.render.addEventListener("click",()=>{
  if(!state.dry||state.offlineWorker)return;
  state.offline=null;controls.download.disabled=true;controls.render.disabled=true;
  $("#progress").value=0;message("WAV書出し用オフライン処理中（試聴とは独立）…");
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
    controls.render.disabled=false;worker.terminate();state.offlineWorker=null;
    message("オフライン処理失敗: "+e.message,"error");
  };
  // Browser-WASM export allocates whole input+output; do not silently OOM
  // for a long stereo 600s file. Live preview has no such full WASM buffer.
  const totalSamples=state.dry.reduce((n,c)=>n+c.length,0);
  if(totalSamples>40_000_000){
    controls.render.disabled=false;
    message("10分の試聴は可能です。WAV一括書出しはメモリ保護のため合計4000万サンプルまでです。","warning");
    return;
  }
  const copies=state.dry.map(c=>new Float32Array(c));
  worker.postMessage({
    type:"process",channels:copies,sampleRate:state.decoded.sampleRate,settings
      :settings()
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
const dialog=$("#settings-dialog"),opener=$("#settings-open");
const showSettings=()=>{if(!dialog.open)dialog.showModal();};
const closeSettings=()=>{if(dialog.open)dialog.close();opener.focus();};
opener.addEventListener("click",showSettings);
$("#settings-inline").addEventListener("click",showSettings);
$("#settings-close").addEventListener("click",closeSettings);
$("#settings-done").addEventListener("click",closeSettings);
dialog.addEventListener("click",event=>{
  if(event.target===dialog)closeSettings();
});
$("#settings-reset").addEventListener("click",()=>{
  const defaults={
    low:"0",high:"968",curvature:"1",invert:"0",wet:"1","axis-shift":"0","axis-pivot":"414","axis-slope":"1",
    engine:"1",mode:"fold-h",outside:"pass",quality:"eco",
    overlap:"4","zero-mode":"0"
  };
  for(const [id,value] of Object.entries(defaults))$("#"+id).value=value;
  $("#ring-enabled").checked=false;$("#rational-enabled").checked=false;
  $("#a-min").value="0";$("#a-reverb").value="0";
  $("#a-min-value").value="20";$("#a-reverb-value").value="0";
  $("#crusher-enabled").checked=false;
  $("#crusher-bits").value="8";$("#crusher-hold").value="4";
  $("#crusher-bits-value").value="8";
  $("#crusher-hold-value").value="4";
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
const sinePitch=()=>Number($("#sine-pitch").value);
const sineFrequency=()=>440*2**((sinePitch()-69)/12);
function updateSineLabel(){
  const value=sinePitch(),nearest=Math.round(value);
  const note=NOTE_NAMES[((nearest%12)+12)%12]+(Math.floor(nearest/12)-1);
  const cents=Math.round((value-nearest)*100);
  $("#sine-note").textContent=note;
  $("#sine-cent").value=String(cents);
  $("#sine-hz").value=sineFrequency().toFixed(2);
  if(state.sine&&state.ctx)state.sine.osc.frequency.setTargetAtTime(sineFrequency(),state.ctx.currentTime,.012);
}
function stopSine(){
  const sine=state.sine;state.sine=null;
  if(!sine)return;
  try{sine.osc.stop();sine.osc.disconnect();sine.gain.disconnect();}catch{}
}
$("#sine-pitch").addEventListener("input",updateSineLabel);
$("#sine-hz").addEventListener("change",()=>{
  const hz=clamp(Number($("#sine-hz").value)||440,65,2100);
  $("#sine-pitch").value=String(clamp(69+12*Math.log2(hz/440),36,96));
  updateSineLabel();
});
$("#sine-cent").addEventListener("change",()=>{
  const cents=clamp(Number($("#sine-cent").value)||0,-50,50);
  const root=Math.round(Number($("#sine-pitch").value));
  $("#sine-pitch").value=String(clamp(root+cents/100,36,96));
  updateSineLabel();
});
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
attachHarmonicPanel(id=>{updateParams(id);updateEngineInfo();},foldPoint,axisMarker);
labels();drawCurve();updateEngineInfo();refreshPlayhead();
ensureSharedCore().catch(()=>{});
