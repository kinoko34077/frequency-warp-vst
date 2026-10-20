/** Supplemental local Audio Lab comparison; DOES NOT apply Frequency Warp f-to-g mapping. */
export const CYCLE_CHOICES=Object.freeze([.5,1,2,4,8,16,32]);
export const BACKENDS=Object.freeze(['pv','wsola','dual','am']);
export const SHORT_WINDOWS=Object.freeze([256,512,1024,2048]);
export const LONG_WINDOWS=Object.freeze([1024,2048,4096,8192]);
export const cycleFromPosition=position=>CYCLE_CHOICES[Number(position)+1];
export function modelControls({individual,backend,cycles,short,long,speed,pitch}){
 if(!BACKENDS.includes(backend)||!CYCLE_CHOICES.includes(cycles)||
  !SHORT_WINDOWS.includes(short)||!LONG_WINDOWS.includes(long)||
  !Number.isFinite(speed)||speed<.5||speed>2||
  !Number.isInteger(pitch)||pitch<-12||pitch>12)throw RangeError('不正なLabモデル設定');
 if(backend==='dual'&&short>=long)throw RangeError('短窓は長窓より短くしてください');
 return {model:individual?'period-joint':backend,jointBackend:individual?backend:null,
  periodCycles:cycles,shortFftSize:short,longFftSize:long,
  fftSize:Math.min(4096,long),speed,semitones:pitch};
}
export function mountLabComparison({getSource,getPosition,getContext,stopBase}){
 const $=id=>document.querySelector(id),p='#lab-port-';
 const backend=$(p+'backend'),individual=$(p+'individual'),
  cycles=$(p+'cycles'),short=$(p+'short'),long=$(p+'long'),
  speed=$(p+'speed'),pitch=$(p+'pitch'),preview=$(p+'preview'),halt=$(p+'stop'),
  status=$(p+'status');
 let worker=null,node=null,token=0;
 function cancel(){
  token++;
  if(worker){worker.terminate();worker=null;}
  if(node){try{node.stop();}catch{}try{node.disconnect();}catch{}node=null;}
  halt.disabled=true;preview.disabled=!getSource()?.channels;
 }
 function refresh(){
  const mode=backend.value,active=individual.checked;
  $(p+'cycles-field').hidden=!active;cycles.disabled=!active;
  short.disabled=!(mode==='wsola'||mode==='dual');
  long.disabled=mode==='wsola';
  $(p+'cycles-output').textContent=cycleFromPosition(cycles.value)+'周期';
  $(p+'speed-output').textContent=Number(speed.value).toFixed(2)+'×';
  $(p+'pitch-output').textContent=pitch.value+'半音';
  $(p+'explainer').textContent=active?
    '個別波長 '+cycleFromPosition(cycles.value)+'周期で共通部分音を推定し、残りを'+mode.toUpperCase()+'で処理します。トランジェント・低域の品質は研究中です。':
    '個別波長OFF：'+mode.toUpperCase()+'で原音を処理。選択中モデルの有効な窓だけを適用します。';
  preview.disabled=!getSource()?.channels;
 }
 function report(msg){status.textContent=msg;}
 for(const el of [backend,individual,cycles,short,long,speed,pitch]){
  el.addEventListener('input',()=>{cancel();refresh();});
  el.addEventListener('change',refresh);
 }
 preview.addEventListener('click',async()=>{
  const source=getSource();
  if(!source?.channels?.length){report('先に音源を開いてください。');return;}
  let options;try{options=modelControls({
   backend:backend.value,individual:individual.checked,cycles:cycleFromPosition(cycles.value),
   short:Number(short.value),long:Number(long.value),speed:Number(speed.value),pitch:Number(pitch.value)
  });}catch(e){report(e.message);return;}
  cancel();const my=token,sourceTag=source.sourceToken;
  const position=Math.max(0,Math.min(source.channels[0].length-1,
    Math.floor(getPosition()*source.sampleRate)));
  const length=Math.min(source.channels[0].length-position,Math.ceil(source.sampleRate*1.5));
  if(length<Math.ceil(source.sampleRate*.04)){report('音声末尾のため試聴区間が短すぎます。');return;}
  const channels=source.channels.map(x=>x.slice(position,position+length));
  report('試聴区間を解析中…（音声は端末内のみ）');
  try{
   await stopBase();
   if(my!==token)return;
   worker=new Worker(new URL('./lab-port-worker.mjs',import.meta.url),{type:'module'});
   const owned=worker;
   worker.onmessage=async ({data})=>{
    if(my!==token||worker!==owned||getSource()?.sourceToken!==sourceTag)return;
    worker.terminate();worker=null;
    if(data.type==='error'){report('解析失敗：'+data.message);refresh();return;}
    try{
     const ctx=await getContext();
     if(my!==token||getSource()?.sourceToken!==sourceTag)return;
     const buffer=ctx.createBuffer(data.channels.length,data.channels[0].length,source.sampleRate);
     data.channels.forEach((x,i)=>buffer.copyToChannel(x,i));
     const output=ctx.createBufferSource();
     output.buffer=buffer;output.connect(ctx.destination);node=output;
     output.onended=()=>{if(node===output){node=null;halt.disabled=true;}};
     output.start();halt.disabled=false;preview.disabled=false;
     report('試聴中 · '+(options.jointBackend?'個別波長＋':'')+backend.value.toUpperCase()+' · '+data.duration.toFixed(2)+'秒');
    }catch(e){report('試聴開始に失敗：'+e.message);refresh();}
   };
   worker.onerror=e=>{
    if(my!==token||worker!==owned)return;
    worker.terminate();worker=null;report('試聴処理が失敗しました。'+(e.message||''));refresh();
   };
   worker.postMessage({channels,sampleRate:source.sampleRate,sourceStartSeconds:position/source.sampleRate,options},
     channels.map(ch=>ch.buffer));
   halt.disabled=false;
  }catch(e){if(my===token){report('試聴準備に失敗：'+e.message);refresh();}}
 });
 halt.addEventListener('click',()=>{cancel();report('試聴停止');});
 document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='hidden')cancel();});
 refresh();
 return {cancel,refresh};
}
