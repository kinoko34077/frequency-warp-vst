import {DISPLAY_MIN,DISPLAY_MAX,graphSegments} from "./harmonics.mjs";
import {sampleHoldImages} from "./crusher-visual.mjs";
// Geometry/frequency map is the SAME Rust/WASM function as native audio.
// For an enabled crusher, additional output images are the mathematically
// exact individual LINEAR sample-and-hold response to a single complex tone.
// Real audio after clipping/bit quantisation is nonlinear and depends on
// waveform phase and amplitude; the plot must never claim to be its FFT.

const clamp01=x=>Math.max(0,Math.min(1,Number(x)||0));
const hzLabel=v=>v>=1000?(v/1000).toFixed(v%1000?2:0)+"k":v>=1?String(Number(v.toFixed(2))):String(Number(v.toFixed(3)));

/** Square axes with a defined 0Hz origin for both linear and log-like views.
 * Gα(f)=(1-α) f/M+α log(1+f/20)/log(1+M/20).
 */
export function drawFrequencyGraph(canvas,settings,warp,translate,maxHz=DISPLAY_MAX,logAmount=0){
  const ratio=Math.min(globalThis.devicePixelRatio||1,2),MAX=maxHz;
  const size=Math.max(250,Math.round(canvas.getBoundingClientRect().width*ratio));
  canvas.width=size;canvas.height=size;
  const ctx=canvas.getContext("2d");
  const side=size-52*ratio,left=38*ratio,top=12*ratio,right=left+side,bottom=top+side;
  const amount=clamp01(logAmount);
  const position=f=>{
    const hz=Math.max(0,Number(f));
    return (1-amount)*hz/MAX+amount*Math.log1p(hz/20)/Math.log1p(MAX/20);
  };
  const x=f=>left+position(f)*side,y=f=>bottom-position(f)*side;
  const invert=t=>{
    if(amount===0)return MAX*t;
    if(amount===1)return 20*Math.expm1(t*Math.log1p(MAX/20));
    let lo=0,hi=MAX;
    for(let i=0;i<24;i++){
      const mid=(lo+hi)/2;
      if(position(mid)<t)lo=mid;else hi=mid;
    }
    return (lo+hi)/2;
  };
  ctx.clearRect(0,0,size,size);
  ctx.fillStyle="#081a1f";ctx.fillRect(left,top,side,side);
  // Source in-band region is vertical; source outside Pass is independent.
  const sourceLo=Math.max(0,settings.low),sourceHi=Math.min(MAX,settings.high);
  if(sourceHi>sourceLo){
    ctx.fillStyle="rgba(60,212,168,.10)";
    ctx.fillRect(x(sourceLo),top,x(sourceHi)-x(sourceLo),side);
  }
  const ticks=amount>=.5?
    (MAX===20000?[0,20,50,100,200,500,1000,2000,5000,10000,20000]:
      [0,20,50,100,200,500,1000,2000]):
    (MAX===20000?[0,5000,10000,15000,20000]:[0,500,1000,1500,2000]);
  ctx.strokeStyle="#244149";ctx.lineWidth=ratio;
  ctx.font=(10*ratio)+"px system-ui";ctx.textBaseline="top";
  let lastX=-1e4;
  for(const t of ticks){
    const xx=x(t),yy=y(t);
    if(xx-lastX<27*ratio&&t!==MAX)continue;
    lastX=xx;ctx.beginPath();ctx.moveTo(xx,top);ctx.lineTo(xx,bottom);
    ctx.moveTo(left,yy);ctx.lineTo(right,yy);ctx.stroke();
    ctx.fillStyle="#9cb7bb";ctx.textAlign="center";
    ctx.fillText(hzLabel(t),xx,bottom+5*ratio);
    ctx.textBaseline="middle";ctx.textAlign="right";
    ctx.fillText(hzLabel(t),left-5*ratio,yy);
    ctx.textAlign="center";ctx.textBaseline="top";
  }
  for(const [value,label] of [[settings.low,"L"],[settings.high,"H"]]){
    if(value<0||value>MAX)continue;
    const xx=x(value);ctx.save();ctx.setLineDash([3*ratio,3*ratio]);
    ctx.strokeStyle="#e1b67b";ctx.beginPath();ctx.moveTo(xx,top);
    ctx.lineTo(xx,bottom);ctx.stroke();ctx.restore();
    ctx.fillStyle="#e1b67b";ctx.textAlign="center";
    ctx.fillText(label,xx,top+4*ratio);
  }
  if(settings.axisPivot>=0&&settings.axisPivot<=MAX){
    const xx=x(settings.axisPivot);
    ctx.save();ctx.strokeStyle="#ffd37e";ctx.setLineDash([3*ratio,5*ratio]);
    ctx.beginPath();ctx.moveTo(xx,top);ctx.lineTo(xx,bottom);ctx.stroke();
    ctx.restore();ctx.fillStyle="#ffd37e";ctx.textAlign="center";
    ctx.fillText("起点",xx,top+5*ratio);
  }
  const wet=clamp01(settings.wet??1),crusher=Number(settings.crusherBits)>0;
  const hold=Number(settings.crusherHold)||0,sampleRate=Number(settings.sampleRate)||48000;
  const updateHz=hold>0?sampleRate/hold:0;

  // Plot true dry mix only when Wet<100%. Old graph falsely displayed
  // a dashed original even at 100% Wet.
  if(wet<1){
    ctx.strokeStyle="#8c9fa6";ctx.globalAlpha=1-wet;ctx.lineWidth=1.2*ratio;
    ctx.beginPath();ctx.moveTo(x(0),y(0));ctx.lineTo(x(MAX),y(MAX));ctx.stroke();
    ctx.globalAlpha=1;
  }
  if(crusher&&hold>0){
    const drawThreshold=(v,label,strong)=>{
      if(v<0||v>MAX)return;
      const yy=y(v);ctx.save();
      ctx.globalAlpha=strong?.85:.25;
      ctx.strokeStyle=strong?"#ffe1a2":"#d7ab71";
      ctx.setLineDash(strong?[4*ratio,3*ratio]:[2*ratio,6*ratio]);
      ctx.beginPath();ctx.moveTo(left,yy);ctx.lineTo(right,yy);ctx.stroke();
      ctx.restore();
      if(strong&&yy>top+13*ratio){
        ctx.fillStyle="#ffe1a2";ctx.textAlign="right";ctx.textBaseline="bottom";
        ctx.font=(9*ratio)+"px system-ui";
        ctx.fillText(label,right-3*ratio,yy-2*ratio);
      }
    };
    // The rate grid's Nyquist reflection: output baseband is 0..Feff/2.
    drawThreshold(updateHz/2,"y="+hzLabel(updateHz/2)+"Hz (鏡)",true);
    drawThreshold(updateHz,"y="+hzLabel(updateHz)+"Hz",false);
    for(let k=2;k<=6;k++)drawThreshold(k*updateHz/2,"",false);
  }else if(crusher){
    // At 0Hz a newly latched sample is DC, not an aliasing "fold".
    ctx.fillStyle="#ffe1a2";ctx.textAlign="right";ctx.textBaseline="bottom";
    ctx.font=(10*ratio)+"px system-ui";
    ctx.fillText("y=0 Hz · 固定値",right-4*ratio,bottom-3*ratio);
  }

  const rows=graphSegments(settings,warp,translate,MAX,invert);
  // Graph can display at most two Ring sidebands per original frequency.
  // A cosine carrier makes two half-amplitude sidebands. A zero-Hz
  // carrier makes one full-amplitude component (not two separate partials).
  const channels=settings.ringEnabled?2:1;
  const validPoint=(point,ch)=>{
    const frequency=point.outputs[ch];
    if(!Number.isFinite(frequency)||frequency<0||frequency>MAX)return null;
    const refl=point.reflected?clamp01(point.reflectionGain??1):1;
    const ringHalf=settings.ringEnabled&&point.inside&&
      Number(settings.carrierHz)!==0?.5:1;
    if(ch===1&&ringHalf===1&&point.inside)return null;
    return {frequency,gain:refl*ringHalf,inside:point.inside,
      reflected:Boolean(point.reflected)};
  };
  // Each physical segment is given the mean of the endpoint amplitudes.
  // This allows attenuation to vary continuously; one shared long Canvas
  // path would incorrectly use one alpha for the whole trajectory.
  function trace(get,col){
    ctx.strokeStyle=col;ctx.lineWidth=1.35*ratio;
    let previous=null;
    for(const point of rows){
      const v=get(point);
      if(!v||!Number.isFinite(v.frequency)||v.frequency<0||v.frequency>MAX){
        previous=null;continue;
      }
      const current={x:x(point.f),y:y(v.frequency),
        gain:clamp01(v.gain),inside:v.inside,reflected:v.reflected,
        segmentId:v.segmentId};
      if(previous&&previous.inside===current.inside &&
         previous.reflected===current.reflected &&
         previous.segmentId===current.segmentId &&
         Math.abs(previous.y-current.y)<side*.34){
        ctx.globalAlpha=wet*(previous.gain+current.gain)/2;
        if(ctx.globalAlpha>0){
          ctx.beginPath();ctx.moveTo(previous.x,previous.y);
          ctx.lineTo(current.x,current.y);ctx.stroke();
        }
      }
      previous=current;
    }
    ctx.globalAlpha=1;
  }

  if(!crusher){
    for(let ch=0;ch<channels;ch++){
      trace(point=>{
        const p=validPoint(point,ch);return p?{...p,segmentId:0}:null;
      },ch===0?"#66e9ba":"#f0b97b");
    }
  }else{
    // Render the *post-crusher* linear sample-hold image, not a dashed
    // phantom frequency line. We retain five strongest near-baseband
    // image orders + original carrier if distinct. Individual magnitudes
    // are exact for an analytic complex sinusoid, but the finite list is
    // not the complete quantised/polyphonic programme spectrum.
    const imageCache=rows.map(point=>
      Array.from({length:channels},(_,ch)=>{
        const p=validPoint(point,ch);
        if(!p)return null;
        const images=sampleHoldImages(p.frequency,sampleRate,hold,2);
        const centre=updateHz>0?-Math.round(p.frequency/updateHz):0;
        return {point:p,images,centre};
      }));
    for(let ch=0;ch<channels;ch++){
      for(const branch of [0,-1,1,-2,2,"carrier"]){
        const colour=branch===0?"#ffca7b":branch==="carrier"?"#e0aa83":
          ch===0?"#e3a15d":"#cda4bc";
        let index=0;
        trace(()=>{
          const data=imageCache[index++]?.[ch];
          if(!data)return null;
          const order=branch==="carrier"?0:data.centre+branch;
          if(branch==="carrier" && Math.abs(data.centre)<=2)return null;
          const img=data.images.find(x=>x.order===order);
          if(!img)return null;
          return {frequency:img.hz,
            gain:data.point.gain*img.gain,
            inside:data.point.inside,reflected:data.point.reflected,
            segmentId:branch};
        },colour);
      }
    }
  }
  ctx.globalAlpha=1;ctx.fillStyle="#b4c6c5";
  ctx.font=(11*ratio)+"px system-ui";ctx.textAlign="center";
  ctx.textBaseline="alphabetic";
  ctx.fillText("Input f (Hz)",(left+right)/2,size-3*ratio);
  ctx.save();ctx.translate(11*ratio,(top+bottom)/2);ctx.rotate(-Math.PI/2);
  ctx.fillText("Output f′ (Hz)",0,0);ctx.restore();
}
