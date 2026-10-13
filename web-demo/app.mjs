import {QUALITY,mapFrequency,mixWet} from "./dsp.mjs";

const $=id=>document.querySelector(id);
const controls={
  dry:$("#play-dry"),wet:$("#play-wet"),stop:$("#stop"),
  render:$("#render"),download:$("#download")
};
const state={
  ctx:null,decoded:null,dry:null,offline:null,offlineWorker:null,
  module:null,workletLoaded:false,player:null,position:0,seek:0,
  qualityIndex:0,settingsRevision:0,name:"audio",processing:false,
  effective:{low:20,high:16000},raf:0,lastStats:null
};
window.__warpDebug=()=>({context:state.ctx?.state||"none",playing:!!state.player,messages:state.player?.startupMessages||[],workletLoaded:state.workletLoaded,wasmCompiled:!!state.module});
const hzFromScale=value=>20*Math.exp(Math.log(1000)*Number(value)/1000);
const scaleFromHz=hz=>Math.round(1000*Math.log(Math.max(20,hz)/20)/Math.log(1000));
const hzText=hz=>hz>=1000?(hz/1000).toFixed(hz>=10000?1:2)+" kHz":Math.round(hz)+" Hz";
const clamp=(x,a,b)=>Math.max(a,Math.min(b,x));
const fmtTime=seconds=>{
  const s=Math.max(0,seconds);
  return Math.floor(s/60)+":"+(s%60).toFixed(1).padStart(4,"0");
};
const duration=()=>state.dry?.length?state.dry[0].length/state.decoded.sampleRate:0;
function message(text,type="info"){$("#status").textContent=text;$("#status").dataset.kind=type;}
function indicator(text){$("#rt-indicator").textContent=text;}
function bounds(changed=""){
  const cap=state.decoded?Math.min(20000,state.decoded.sampleRate*.45):20000;
  let low=hzFromScale($("#low").value);
  let high=Math.min(cap,hzFromScale($("#high").value));
  low=Math.min(low,cap/1.08);
  if(high<low*1.06){
    if(changed==="low")high=Math.min(cap,low*1.08);
    else low=Math.max(20,high/1.08);
  }
  if(high<=low)low=Math.max(20,high/1.08);
  $("#low").value=String(scaleFromHz(low));
  $("#high").value=String(scaleFromHz(high));
  low=Math.min(hzFromScale($("#low").value),cap/1.08);
  high=Math.min(hzFromScale($("#high").value),cap);
  if(low>=high)low=high/1.08;
  state.effective={low,high};
  $("#low-value").textContent=hzText(low);
  $("#high-value").textContent=hzText(high);
  $("#graph-low").textContent="L: "+hzText(low);
  $("#graph-high").textContent="H: "+hzText(high);
  return state.effective;
}
function settings(){
  const {low,high}=bounds();
  const qualityIndex=({eco:0,standard:1,high:2}[$("#quality").value]);
  return {
    low,high,curvature:Number($("#curvature").value),
    invert:Number($("#invert").value),
    mode:$("#mode").value,outside:$("#outside").value,qualityIndex
  };
}
function labels(id=""){
  bounds(id);
  $("#curvature-value").textContent=Number($("#curvature").value).toFixed(2);
  $("#invert-value").textContent=Math.round(100*Number($("#invert").value))+"%";
  $("#wet-value").textContent=Math.round(100*Number($("#wet").value))+"%";
}
function drawCurve(){
  const canvas=$("#curve"),ratio=Math.min(devicePixelRatio||1,2);
  canvas.width=Math.max(240,Math.round(canvas.getBoundingClientRect().width*ratio));
  canvas.height=180*ratio;
  const ctx=canvas.getContext("2d"),w=canvas.width,h=canvas.height;
  ctx.clearRect(0,0,w,h);
  ctx.strokeStyle="#637e86";ctx.setLineDash([5*ratio,5*ratio]);
  ctx.beginPath();ctx.moveTo(0,h);ctx.lineTo(w,0);ctx.stroke();ctx.setLineDash([]);
  ctx.strokeStyle="#4ed2b2";ctx.lineWidth=2.5*ratio;ctx.beginPath();
  const {low,high}=state.effective;
  const p=Number($("#curvature").value),a=Number($("#invert").value),mode=$("#mode").value;
  for(let i=0;i<=256;i++){
    const f=low+(high-low)*i/256,v=mapFrequency(f,low,high,p,a,mode);
    const x=i*w/256,y=(1-(v-low)/(high-low))*h;
    if(i===0)ctx.moveTo(x,y);else ctx.lineTo(x,y);
  }
  ctx.stroke();
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
  if(!state.module){
    const response=await fetch("./dsp_core.wasm");
    if(!response.ok)throw Error("Rust WASMの読込みに失敗: "+response.status);
    const bytes=await response.arrayBuffer();
    state.module=await WebAssembly.compile(bytes);
  }
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
  const now=state.ctx.currentTime,wet=p.mode==="wet"?Number($("#wet").value):0;
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
      const latency=1000*data.latencyFrames/state.ctx.sampleRate;
      indicator("リアルタイム動作中 · DSP遅延 "+latency.toFixed(1)+" ms · 約 "+
        data.averageBlockMs.toFixed(2)+" ms/block");
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
  state.seek=where;
  if(!p)return;
  // Short host mute covers state reset and rebuffering at the new position.
  const now=state.ctx.currentTime;
  p.master.gain.cancelScheduledValues(now);
  p.master.gain.setTargetAtTime(0,now,.008);
  startSource(p,where);
  p.master.gain.setTargetAtTime(1,now+.040,.02);
  message("波形位置 "+fmtTime(where)+" から再生します。","info");
}
async function stop(){
  const p=state.player;
  if(!p){controls.stop.disabled=true;return;}
  state.seek=playPosition();
  state.player=null;
  try{p.source?.stop();}catch{}
  try{p.source?.disconnect();p.worklet.disconnect();p.wet.disconnect();p.dry.disconnect();p.master.disconnect();}catch{}
  try{p.worklet.port.postMessage({type:"dispose"});}catch{}
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
      mode,quality:current.qualityIndex,at:ctx.currentTime,
      offset:0,appliedRevision:0,startupMessages:[]
    };
    state.player=player;
    worklet.port.onmessage=playerMessage(worklet,player);
    worklet.addEventListener("processorerror",()=>{message("AudioWorklet processorerror","error");player.startupMessages.push("processorerror");});
    const ready=new Promise((resolve,reject)=>{
      const timeout=setTimeout(()=>reject(Error("AudioWorkletの起動が時間切れです。")),10000);
      const handler=worklet.port.onmessage;
      worklet.port.onmessage=event=>{
        player.startupMessages.push(event.data.type);
        if(event.data.type==="ready"){clearTimeout(timeout);worklet.port.onmessage=handler;resolve(event.data);}
        else if(event.data.type==="error"){clearTimeout(timeout);reject(Error(event.data.message));}
      };
    });
    // AudioWorklet may remain unscheduled without an active connected input.
    // Start the input before waiting for the processor's ready message.
    const start=offset===null?state.seek:offset;
    startSource(player,start);
    worklet.port.postMessage({type:"init",module,channels:state.dry.length,settings:current});
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
  labels(changed);drawCurve();
  const p=state.player;
  if(!p)return;
  const current=settings();
  if(current.qualityIndex!==p.quality){
    const offset=playPosition(),mode=p.mode;
    stop().then(()=>play(mode,offset));
    return;
  }
  const revision=++state.settingsRevision;
  p.worklet.port.postMessage({
    type:"params",settings:current,activeQualityIndex:p.quality,revision
  });
  indicator("リアルタイム動作中 · パラメータ更新中…");
}
for(const name of ["low","high","curvature","invert","mode","outside","quality"]){
  $("#"+name).addEventListener("input",()=>updateParams(name));
}
$("#wet").addEventListener("input",()=>{labels();tuneWet();});
controls.dry.addEventListener("click",()=>play("dry"));
controls.wet.addEventListener("click",()=>play("wet"));
controls.stop.addEventListener("click",()=>stop());
window.addEventListener("resize",()=>{drawCurve();drawAudio();});
window.addEventListener("pagehide",()=>{stop();if(state.offlineWorker)state.offlineWorker.terminate();});
async function load(file){
  if(!file)return;
  await stop();
  if(state.offlineWorker){state.offlineWorker.terminate();state.offlineWorker=null;}
  state.offline=null;state.decoded=null;state.dry=null;state.seek=0;
  for(const node of [controls.dry,controls.wet,controls.render,controls.download])node.disabled=true;
  message("音声をデコード中…");
  try{
    if(file.size>75_000_000)throw Error("最大75MBです。");
    const ctx=await context();
    const data=await ctx.decodeAudioData(await file.arrayBuffer());
    const count=Math.min(2,data.numberOfChannels);
    const length=Math.min(data.length,Math.floor(data.sampleRate*120));
    if(length<4096)throw Error("短すぎる音声です。");
    state.decoded=data;
    state.dry=Array.from({length:count},(_,i)=>data.getChannelData(i).slice(0,length));
    state.name=file.name.replace(/\.[^.]+$/,"");
    $("#file-meta").textContent=file.name+" · "+duration().toFixed(1)+"秒 · "+data.sampleRate+"Hz · "+count+"ch";
    labels("high");drawCurve();drawAudio();refreshStatusSeek();
    controls.dry.disabled=false;controls.wet.disabled=false;controls.render.disabled=false;
    message("音声の準備が完了しました。再生ボタンか波形上の位置を押してください。");
  }catch(error){message("読み込み失敗: "+error.message,"error");}
}
$("#audio-file").addEventListener("change",e=>load(e.target.files[0]));
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
  const mixed=state.offline.map((ch,i)=>mixWet(state.dry[i],ch,Number($("#wet").value)));
  const url=URL.createObjectURL(makeWav(mixed,state.decoded.sampleRate));
  const el=document.createElement("a");el.href=url;el.download=state.name+"-frequency-warp.wav";
  document.body.append(el);el.click();el.remove();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
});
labels();drawCurve();refreshPlayhead();
