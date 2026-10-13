import {QUALITY, mapFrequency, mixWet} from "./dsp.mjs";
const $=s=>document.querySelector(s);
const state={context:null,decoded:null,dry:null,processed:null,mix:null,source:null,worker:null,name:"audio"};
const buttons={render:$("#render"),original:$("#play-dry"),converted:$("#play-wet"),download:$("#download"),stop:$("#stop")};
function message(text,type="info"){$("#status").textContent=text;$("#status").dataset.kind=type;}
function refreshLabels(){
  $("#invert-value").textContent=Math.round(100*Number($("#invert").value))+"%";
  $("#wet-value").textContent=Math.round(100*Number($("#wet").value))+"%";
  $("#curvature-value").textContent=Number($("#curvature").value).toFixed(2);
}
async function audioContext(){
  if(!state.context)state.context=new AudioContext();
  await state.context.resume();
  return state.context;
}
function stop(){
  if(state.source){try{state.source.stop();}catch{}state.source.disconnect();state.source=null;}
  buttons.stop.disabled=true;
}
function drawAudio(samples){
  const canvas=$("#wave"),scale=Math.min(2,window.devicePixelRatio||1);
  canvas.width=Math.max(240,Math.round(canvas.getBoundingClientRect().width*scale));
  canvas.height=120*scale;const ctx=canvas.getContext("2d");
  ctx.clearRect(0,0,canvas.width,canvas.height);
  if(!samples)return;
  ctx.strokeStyle="#4ed2b2";ctx.lineWidth=scale;ctx.beginPath();
  const width=canvas.width,height=canvas.height;
  for(let x=0;x<width;x++){
    let low=1,high=-1;
    const start=Math.floor(x*samples.length/width);
    const end=Math.max(start+1,Math.floor((x+1)*samples.length/width));
    for(let i=start;i<end;i++){low=Math.min(low,samples[i]);high=Math.max(high,samples[i]);}
    ctx.moveTo(x,(1-high)*height/2);ctx.lineTo(x,(1-low)*height/2);
  }
  ctx.stroke();
}
function drawCurve(){
  const canvas=$("#curve"),ctx=canvas.getContext("2d"),scale=Math.min(2,window.devicePixelRatio||1);
  canvas.width=Math.max(240,Math.round(canvas.getBoundingClientRect().width*scale));canvas.height=180*scale;
  const w=canvas.width,h=canvas.height;
  ctx.clearRect(0,0,w,h);
  ctx.strokeStyle="#687b85";ctx.globalAlpha=.4;
  ctx.setLineDash([5*scale,5*scale]);ctx.beginPath();ctx.moveTo(0,h);ctx.lineTo(w,0);ctx.stroke();
  ctx.setLineDash([]);ctx.globalAlpha=1;
  const p=Number($("#curvature").value),a=Number($("#invert").value),mode=$("#mode").value;
  ctx.beginPath();
  for(let i=0;i<=256;i++){
    const f=20+19980*i/256;
    const warped=mapFrequency(f,20,20000,p,a,mode);
    const x=i/256*w,y=(1-(warped-20)/19980)*h;
    if(i===0)ctx.moveTo(x,y);else ctx.lineTo(x,y);
  }
  ctx.strokeStyle="#4ed2b2";ctx.lineWidth=2.5*scale;ctx.stroke();
}
refreshLabels();drawCurve();
for(const id of ["invert","curvature","wet","mode","quality"]){
  $("#"+id).addEventListener("input",()=>{
    refreshLabels();drawCurve();
    if(id==="wet" && state.processed){state.mix=mixAll();drawAudio(state.mix[0]);}
    if(id!=="wet" && state.processed){
      message("設定を変更しました。再度「変換」を押して反映してください。","warning");
      buttons.converted.disabled=true;buttons.download.disabled=true;
    }
  });
}
window.addEventListener("resize",()=>{drawCurve();const s=state.mix||state.dry;if(s)drawAudio(s[0]);});
async function load(file){
  if(!file)return;
  stop();
  if(state.worker){state.worker.terminate();state.worker=null;}
  state.decoded=null;state.dry=null;state.processed=null;state.mix=null;
  buttons.render.disabled=true;buttons.original.disabled=true;buttons.converted.disabled=true;buttons.download.disabled=true;
  $("#progress").value=0;
  message("音声を読み込み中…");
  try{
    if(file.size>75_000_000)throw Error("ファイル上限は75MBです。");
    const ctx=await audioContext();
    const decoded=await ctx.decodeAudioData(await file.arrayBuffer());
    const channels=Math.min(2,decoded.numberOfChannels);
    const n=Math.min(decoded.length,Math.floor(decoded.sampleRate*10));
    if(n<4096)throw Error("音声が短すぎます。");
    state.decoded=decoded;
    state.dry=Array.from({length:channels},(_,i)=>decoded.getChannelData(i).slice(0,n));
    state.name=file.name.replace(/\.[^.]+$/,"");
    $("#file-meta").textContent=file.name+" / "+decoded.duration.toFixed(2)+"s / "+decoded.sampleRate+"Hz / "+channels+"ch";
    buttons.render.disabled=false;buttons.original.disabled=false;
    message(decoded.duration>10?"読み込み完了。先頭10秒のみを処理します。":"読み込み完了。変換を開始できます。");
    drawAudio(state.dry[0]);
  }catch(e){message("読み込み失敗: "+e.message,"error");}
}
$("#audio-file").addEventListener("change",e=>load(e.target.files[0]));
const drop=$("#drop");
drop.addEventListener("click",e=>{if(e.target.id!=="audio-file")$("#audio-file").click();});
drop.addEventListener("keydown",e=>{if(e.key==="Enter"||e.key===" "){e.preventDefault();$("#audio-file").click();}});
drop.addEventListener("dragover",e=>{e.preventDefault();drop.classList.add("hover");});
drop.addEventListener("dragleave",()=>drop.classList.remove("hover"));
drop.addEventListener("drop",e=>{e.preventDefault();drop.classList.remove("hover");load(e.dataTransfer.files[0]);});
function mixAll(){
  const wet=Number($("#wet").value);
  return state.processed.map((c,i)=>mixWet(state.dry[i],c,wet));
}
async function play(mode){
  if(!state.dry)return;
  const ctx=await audioContext(),pcm=mode==="dry"?state.dry:state.mix;
  if(!pcm)return;
  stop();
  const output=ctx.createBuffer(pcm.length,pcm[0].length,state.decoded.sampleRate);
  pcm.forEach((channel,i)=>output.copyToChannel(channel,i));
  const source=ctx.createBufferSource();source.buffer=output;source.connect(ctx.destination);
  source.onended=()=>{if(state.source===source){state.source=null;buttons.stop.disabled=true;}};
  source.start();state.source=source;buttons.stop.disabled=false;
}
buttons.original.addEventListener("click",()=>play("dry").catch(e=>message(e.message,"error")));
buttons.converted.addEventListener("click",()=>play("wet").catch(e=>message(e.message,"error")));
buttons.stop.addEventListener("click",stop);
buttons.render.addEventListener("click",()=>{
  if(!state.dry||state.worker)return;
  stop();
  const rate=state.decoded.sampleRate,quality=QUALITY[$("#quality").value];
  const settings={
    low:20,high:Math.min(16000,rate*.45),
    curvature:Number($("#curvature").value),invert:Number($("#invert").value),
    mode:$("#mode").value,fftSize:quality.fftSize,hop:quality.hop,
    peaks:quality.peaks,floor:quality.floor
  };
  if(state.dry[0].length<settings.fftSize){message("音声が短いため低いQualityを選択してください。","error");return;}
  state.processed=null;state.mix=null;
  buttons.render.disabled=true;buttons.converted.disabled=true;buttons.download.disabled=true;
  $("#progress").value=0;message("変換中。ブラウザ内だけで処理しています…");
  state.worker=new Worker(new URL("./processor.worker.mjs",import.meta.url),{type:"module"});
  state.worker.onmessage=e=>{
    const data=e.data;
    if(data.type==="progress")$("#progress").value=Math.round(data.value*100);
    else if(data.type==="done"){
      state.processed=data.channels;
      state.mix=mixAll();
      state.worker.terminate();state.worker=null;
      buttons.render.disabled=false;buttons.converted.disabled=false;buttons.download.disabled=false;
      $("#progress").value=100;drawAudio(state.mix[0]);
      message("変換完了。"+data.diagnostics.peaks+"個のピークを処理しました。ノイズや残響には欠落が起こり得ます。");
    }else if(data.type==="error"){
      state.worker.terminate();state.worker=null;buttons.render.disabled=false;
      message("処理失敗: "+data.message,"error");
    }
  };
  state.worker.onerror=e=>{
    state.worker.terminate();state.worker=null;buttons.render.disabled=false;
    message("処理失敗: "+(e.message||"Worker error"),"error");
  };
  const copies=state.dry.map(c=>new Float32Array(c));
  state.worker.postMessage({type:"process",channels:copies,sampleRate:rate,settings},copies.map(c=>c.buffer));
});
function makeWave(pcm,rate){
  const count=pcm.length,frames=pcm[0].length,buffer=new ArrayBuffer(44+frames*count*2),view=new DataView(buffer);
  const write=(start,str)=>{for(let i=0;i<str.length;i++)view.setUint8(start+i,str.charCodeAt(i));};
  write(0,"RIFF");view.setUint32(4,36+frames*count*2,true);write(8,"WAVE");
  write(12,"fmt ");view.setUint32(16,16,true);view.setUint16(20,1,true);view.setUint16(22,count,true);
  view.setUint32(24,rate,true);view.setUint32(28,rate*count*2,true);
  view.setUint16(32,count*2,true);view.setUint16(34,16,true);write(36,"data");view.setUint32(40,frames*count*2,true);
  let offset=44;
  for(let i=0;i<frames;i++)for(let c=0;c<count;c++){
    const v=Math.max(-1,Math.min(1,pcm[c][i]));
    view.setInt16(offset,v<0?Math.round(v*32768):Math.round(v*32767),true);offset+=2;
  }
  return new Blob([buffer],{type:"audio/wav"});
}
buttons.download.addEventListener("click",()=>{
  if(!state.mix)return;
  const url=URL.createObjectURL(makeWave(state.mix,state.decoded.sampleRate));
  const element=document.createElement("a");
  element.href=url;element.download=state.name+"-frequency-warp-preview.wav";
  document.body.append(element);element.click();element.remove();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
});
