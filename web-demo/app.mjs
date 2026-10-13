import {QUALITY,mapFrequency,mixWet} from "./dsp.mjs";
const $=selector=>document.querySelector(selector);
const state={
  ctx:null, decoded:null, dry:null, processed:null, worker:null,
  playback:null, name:"audio", timer:null, serial:0,
  effective:{low:20,high:16000}
};
const nodes={
  render:$("#render"),dry:$("#play-dry"),wet:$("#play-wet"),
  stop:$("#stop"),download:$("#download")
};
const TWO_PI=2*Math.PI;
const hzFromScale=value=>20*Math.exp(Math.log(1000)*Number(value)/1000);
const scaleFromHz=hz=>Math.round(1000*Math.log(Math.max(20,hz)/20)/Math.log(1000));
const hzText=hz=>hz>=1000?(hz/1000).toFixed(hz>=10000?1:2)+" kHz":Math.round(hz)+" Hz";
function message(text,type="info"){$("#status").textContent=text;$("#status").dataset.kind=type;}
function audioLength(){return state.dry?.[0]?.length||0;}
function duration(){return state.decoded?audioLength()/state.decoded.sampleRate:0;}
function validatedBounds(changed){
  const cap=state.decoded?Math.min(20000,state.decoded.sampleRate*.45):20000;
  let low=hzFromScale($("#low").value);
  let high=Math.min(cap,hzFromScale($("#high").value));
  low=Math.min(low,cap/1.08);
  if(high<low*1.06){
    if(changed==="low")high=Math.min(cap,low*1.08);
    else low=Math.max(20,high/1.08);
  }
  if(high<=low)low=Math.max(20,high/1.08);
  // Keep actual render and graph values identical despite slider quantization.
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
function labels(changed=""){
  validatedBounds(changed);
  $("#curvature-value").textContent=Number($("#curvature").value).toFixed(2);
  $("#invert-value").textContent=Math.round(100*Number($("#invert").value))+"%";
  $("#wet-value").textContent=Math.round(100*Number($("#wet").value))+"%";
}
function drawAudio(signal){
  const canvas=$("#wave"),ratio=Math.min(2,devicePixelRatio||1);
  canvas.width=Math.max(250,Math.round(canvas.getBoundingClientRect().width*ratio));
  canvas.height=120*ratio;
  const ctx=canvas.getContext("2d");
  ctx.clearRect(0,0,canvas.width,canvas.height);
  if(!signal?.length)return;
  ctx.strokeStyle="#4ed2b2";ctx.lineWidth=ratio;ctx.beginPath();
  for(let x=0;x<canvas.width;x++){
    const start=Math.floor(x*signal.length/canvas.width);
    const end=Math.max(start+1,Math.floor((x+1)*signal.length/canvas.width));
    let lo=1,hi=-1;
    for(let i=start;i<end;i++){lo=Math.min(lo,signal[i]);hi=Math.max(hi,signal[i]);}
    ctx.moveTo(x,(1-hi)*canvas.height/2);
    ctx.lineTo(x,(1-lo)*canvas.height/2);
  }
  ctx.stroke();
}
function drawCurve(){
  const c=$("#curve"),ratio=Math.min(2,devicePixelRatio||1);
  c.width=Math.max(250,Math.round(c.getBoundingClientRect().width*ratio));
  c.height=180*ratio;const ctx=c.getContext("2d");
  const w=c.width,h=c.height;
  ctx.clearRect(0,0,w,h);
  ctx.strokeStyle="#6a8790";ctx.setLineDash([5*ratio,5*ratio]);
  ctx.beginPath();ctx.moveTo(0,h);ctx.lineTo(w,0);ctx.stroke();ctx.setLineDash([]);
  const {low,high}=state.effective;
  const p=Number($("#curvature").value),a=Number($("#invert").value),mode=$("#mode").value;
  ctx.strokeStyle="#4ed2b2";ctx.lineWidth=2.5*ratio;ctx.beginPath();
  for(let i=0;i<=256;i++){
    const f=low+(high-low)*i/256;
    const v=mapFrequency(f,low,high,p,a,mode);
    const x=i/256*w,y=(1-(v-low)/(high-low))*h;
    if(i===0)ctx.moveTo(x,y);else ctx.lineTo(x,y);
  }
  ctx.stroke();
}
function currentPlaybackOffset(ctx){
  const p=state.playback;
  const len=duration();
  if(!p||len<=0)return 0;
  return ((p.offset+Math.max(0,ctx.currentTime-p.at))%len+len)%len;
}
function safeStop(src,at){
  if(!src)return;
  try{src.stop(at);}catch{}
}
function clearPlayback(){
  if(!state.playback){nodes.stop.disabled=true;return;}
  const p=state.playback;
  safeStop(p.drySrc);safeStop(p.wetSrc);
  try{p.dryGain?.disconnect();p.wetGain?.disconnect();}catch{}
  state.playback=null;
  nodes.stop.disabled=true;
}
function audioBuffer(channels){
  const ctx=state.ctx;
  const b=ctx.createBuffer(channels.length,channels[0].length,state.decoded.sampleRate);
  channels.forEach((channel,index)=>b.copyToChannel(channel,index));
  return b;
}
function sourceOn(ctx,b,volume,offset,at){
  const src=ctx.createBufferSource();
  src.buffer=b;src.loop=true;
  const gain=ctx.createGain();gain.gain.value=volume;
  src.connect(gain);gain.connect(ctx.destination);
  src.start(at,offset);
  return {src,gain};
}
function setWetGain(){
  const p=state.playback;
  if(!p||p.mode!=="wet")return;
  const now=state.ctx.currentTime,w=Number($("#wet").value);
  p.dryGain.gain.setTargetAtTime(1-w,now,.015);
  p.wetGain?.gain.setTargetAtTime(w,now,.015);
}
async function context(){
  if(!state.ctx)state.ctx=new AudioContext();
  await state.ctx.resume();return state.ctx;
}
async function play(mode){
  if(!state.dry ||(mode==="wet"&&!state.processed))return;
  const ctx=await context();
  clearPlayback();
  const at=ctx.currentTime+.015,offset=0;
  const dry=sourceOn(ctx,audioBuffer(state.dry),mode==="dry"?1:1-Number($("#wet").value),offset,at);
  const wet=mode==="wet"?sourceOn(ctx,audioBuffer(state.processed),Number($("#wet").value),offset,at):null;
  state.playback={mode,drySrc:dry.src,dryGain:dry.gain,wetSrc:wet?.src,wetGain:wet?.gain,at,offset};
  nodes.stop.disabled=false;
  message(mode==="wet"?"変換音をループ再生中。ツマミ操作は再計算後に自動反映します。":"原音をループ再生中。");
}
function swapProcessedDuringPlayback(){
  const p=state.playback;
  if(!p ||p.mode!=="wet"||!state.processed)return;
  const ctx=state.ctx,now=ctx.currentTime+.02,where=currentPlaybackOffset(ctx);
  const next=sourceOn(ctx,audioBuffer(state.processed),0,where,now);
  const target=Number($("#wet").value);
  next.gain.gain.setValueAtTime(0,now);
  next.gain.gain.linearRampToValueAtTime(target,now+.085);
  if(p.wetGain){
    p.wetGain.gain.cancelScheduledValues(now);
    p.wetGain.gain.setValueAtTime(p.wetGain.gain.value,now);
    p.wetGain.gain.linearRampToValueAtTime(0,now+.085);
  }
  const old=p.wetSrc,oldGain=p.wetGain;
  safeStop(old,now+.12);
  setTimeout(()=>{try{oldGain?.disconnect();}catch{}},200);
  p.wetSrc=next.src;p.wetGain=next.gain;
}
function scheduleAutoRender(){
  if(!state.dry||!$("#auto-update").checked)return;
  if(state.timer)clearTimeout(state.timer);
  state.timer=setTimeout(()=>{state.timer=null;render();},350);
  message("設定変更を検知。変更中の音は継続し、新しい設定を計算後に切り替えます。","warning");
}
const processIDs=["low","high","curvature","invert","mode","outside","quality"];
for(const id of processIDs){
  const node=$("#"+id);
  node.addEventListener("input",()=>{
    labels(id);drawCurve();scheduleAutoRender();
  });
  node.addEventListener("change",()=>{
    if(state.dry&&$("#auto-update").checked){
      if(state.timer)clearTimeout(state.timer);
      state.timer=setTimeout(()=>{state.timer=null;render();},150);
    }
  });
}
$("#wet").addEventListener("input",()=>{
  labels();setWetGain();
  if(state.processed){
    // Draw only a short preview to avoid mixing millions of samples on every tick.
    const preview=Math.min(8192,audioLength());
    drawAudio(mixWet(state.dry[0].subarray(0,preview),state.processed[0].subarray(0,preview),Number($("#wet").value)));
  }
});
$("#auto-update").addEventListener("change",()=>{
  if($("#auto-update").checked)scheduleAutoRender();
});
nodes.dry.addEventListener("click",()=>play("dry").catch(e=>message(e.message,"error")));
nodes.wet.addEventListener("click",()=>play("wet").catch(e=>message(e.message,"error")));
nodes.stop.addEventListener("click",clearPlayback);
window.addEventListener("resize",()=>{drawCurve();drawAudio(state.processed?.[0]||state.dry?.[0]);});
async function load(file){
  if(!file)return;
  clearPlayback();if(state.worker){state.worker.terminate();state.worker=null;}
  if(state.timer)clearTimeout(state.timer);
  state.serial++;
  state.dry=null;state.processed=null;state.decoded=null;
  nodes.render.disabled=true;nodes.dry.disabled=true;nodes.wet.disabled=true;nodes.download.disabled=true;
  $("#progress").value=0;message("デコード中…");
  try {
    if(file.size>75_000_000)throw Error("ファイル上限は75MBです。");
    const ctx=await context();
    const decoded=await ctx.decodeAudioData(await file.arrayBuffer());
    const count=Math.min(2,decoded.numberOfChannels);
    const n=Math.min(decoded.length,Math.floor(decoded.sampleRate*120));
    if(n<4096)throw Error("短すぎる音声です。");
    state.decoded=decoded;
    state.dry=Array.from({length:count},(_,i)=>decoded.getChannelData(i).slice(0,n));
    state.name=file.name.replace(/\.[^.]+$/,"");
    $("#file-meta").textContent=file.name+" / "+decoded.duration.toFixed(2)+"s / "+decoded.sampleRate+"Hz / "+count+"ch";
    labels("high");drawCurve();drawAudio(state.dry[0]);
    nodes.render.disabled=false;nodes.dry.disabled=false;
    message("音声を読込みました（対象"+duration().toFixed(1)+"秒）。設定変更時は自動的に音を再計算します。");
    scheduleAutoRender();
  } catch(e){message("読み込み失敗: "+e.message,"error");}
}
$("#audio-file").addEventListener("change",e=>load(e.target.files[0]));
const drop=$("#drop");
drop.addEventListener("click",e=>{if(e.target.id!=="audio-file")$("#audio-file").click();});
drop.addEventListener("keydown",e=>{if(e.key==="Enter"||e.key===" "){e.preventDefault();$("#audio-file").click();}});
drop.addEventListener("dragover",e=>{e.preventDefault();drop.classList.add("hover");});
drop.addEventListener("dragleave",()=>drop.classList.remove("hover"));
drop.addEventListener("drop",e=>{e.preventDefault();drop.classList.remove("hover");load(e.dataTransfer.files[0]);});
function render(){
  if(!state.dry)return;
  if(state.worker){state.worker.terminate();state.worker=null;}
  const serial=++state.serial;
  const qualityID=$("#quality").value;
  const q=QUALITY[qualityID],bounds=validatedBounds("");
  const options={
    low:bounds.low,high:bounds.high,
    curvature:Number($("#curvature").value),invert:Number($("#invert").value),
    mode:$("#mode").value,outside:$("#outside").value,
    qualityIndex:({eco:0,standard:1,high:2}[qualityID]),
    fftSize:q.fftSize,hop:q.hop
  };
  if(audioLength()<options.fftSize){
    message("このQualityでは音声が短すぎます。Eco等に切り替えてください。","error");return;
  }
  const worker=new Worker(new URL("./processor.worker.mjs",import.meta.url),{type:"module"});
  state.worker=worker;
  nodes.render.disabled=true;$("#progress").value=0;
  const listening=!!state.playback;
  message("共通Rust/WASMで処理中… "+(listening?"再生を続けたまま新音声へ切り替えます。":"完了後に試聴できます。"));
  worker.onmessage=e=>{
    if(serial!==state.serial||state.worker!==worker)return;
    const data=e.data;
    if(data.type==="progress")$("#progress").value=Math.round(data.value*100);
    else if(data.type==="done"){
      state.processed=data.channels;
      worker.terminate();state.worker=null;
      nodes.render.disabled=false;nodes.wet.disabled=false;nodes.download.disabled=false;
      $("#progress").value=100;
      swapProcessedDuringPlayback();
      drawAudio(state.processed[0]);
      message("処理反映済み（"+(data.diagnostics.elapsedMs/1000).toFixed(2)+"秒）。再生中は同じ位置で滑らかに切替えます。");
    }else if(data.type==="error"){
      worker.terminate();state.worker=null;nodes.render.disabled=false;
      message("変換失敗: "+data.message,"error");
    }
  };
  worker.onerror=e=>{
    if(serial!==state.serial)return;
    worker.terminate();state.worker=null;nodes.render.disabled=false;
    message("変換失敗: "+(e.message||"Worker error"),"error");
  };
  const copies=state.dry.map(c=>new Float32Array(c));
  worker.postMessage({type:"process",channels:copies,sampleRate:state.decoded.sampleRate,settings:options},copies.map(c=>c.buffer));
}
nodes.render.addEventListener("click",()=>{if(state.timer)clearTimeout(state.timer);render();});
function makeWave(pcm,rate){
  const count=pcm.length,frames=pcm[0].length,buffer=new ArrayBuffer(44+frames*count*2);
  const view=new DataView(buffer);
  const write=(start,str)=>{for(let i=0;i<str.length;i++)view.setUint8(start+i,str.charCodeAt(i));};
  write(0,"RIFF");view.setUint32(4,36+frames*count*2,true);write(8,"WAVE");
  write(12,"fmt ");view.setUint32(16,16,true);view.setUint16(20,1,true);view.setUint16(22,count,true);
  view.setUint32(24,rate,true);view.setUint32(28,rate*count*2,true);view.setUint16(32,count*2,true);
  view.setUint16(34,16,true);write(36,"data");view.setUint32(40,frames*count*2,true);
  let at=44;
  for(let i=0;i<frames;i++)for(let c=0;c<count;c++){
    const v=Math.max(-1,Math.min(1,pcm[c][i]));
    view.setInt16(at,v<0?Math.round(v*32768):Math.round(v*32767),true);at+=2;
  }
  return new Blob([buffer],{type:"audio/wav"});
}
nodes.download.addEventListener("click",()=>{
  if(!state.processed)return;
  const mix=state.processed.map((c,i)=>mixWet(state.dry[i],c,Number($("#wet").value)));
  const url=URL.createObjectURL(makeWave(mix,state.decoded.sampleRate));
  const el=document.createElement("a");el.href=url;el.download=state.name+"-frequency-warp.wav";
  document.body.append(el);el.click();el.remove();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
});
labels();drawCurve();
