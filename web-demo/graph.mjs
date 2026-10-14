import {DISPLAY_MIN,DISPLAY_MAX,graphSegments} from "./harmonics.mjs";
import {sampleHoldImage} from "./crusher-visual.mjs";
// Geometry only. Live mapping is supplied by the SAME compiled Rust/WASM
// function warp_map_frequency used by native streaming DSP.

/** Equal-scale 0..2000/20000Hz plot. The precrusher map comes from shared
 * Rust/WASM. ZOH image frequencies/weights use the analytic linear
 * sample-hold response; amplitude quantization is nonlinear and is NEVER
 * represented as a single deterministic function of the input frequency.
 */
export function drawFrequencyGraph(canvas,settings,warp,translate,maxHz=DISPLAY_MAX,logAmount=0) {
  const ratio=Math.min(globalThis.devicePixelRatio||1,2);
  const MAX=maxHz;
  const size=Math.max(250,Math.round(canvas.getBoundingClientRect().width*ratio));
  canvas.width=size;canvas.height=size;
  const ctx=canvas.getContext("2d");
  // Plot *inside* the canvas is square, not just the outer canvas.
  // Thus 100 Hz has equal physical extent on both x and y axes.
  const side=size-52*ratio,left=38*ratio,top=12*ratio;
  const right=left+side,bottom=top+side;
  const width=side,height=side;
  const amount=Math.min(1,Math.max(0,logAmount));
  // log1p keeps zero physically on both axes. Unlike ln(f/20),
  // there is no artificial discontinuity/clamp below 20Hz.
  const position=f=>(1-amount)*Math.max(0,f)/MAX+
    amount*Math.log1p(Math.max(0,f)/20)/Math.log1p(MAX/20);
  const x=f=>left+position(f)*width;
  const y=f=>bottom-position(f)*height;
  ctx.clearRect(0,0,size,size);
  ctx.fillStyle="#081a1f";ctx.fillRect(left,top,width,height);
  {
    const lo=Math.max(DISPLAY_MIN,settings.low),hi=Math.min(MAX,settings.high);
    if(hi>lo){ctx.fillStyle="rgba(60,212,168,.12)";ctx.fillRect(x(lo),top,x(hi)-x(lo),height);}
  }
  ctx.font=(10*ratio)+"px system-ui";ctx.textAlign="center";ctx.textBaseline="top";
  ctx.strokeStyle="#244149";ctx.lineWidth=ratio;
  const ticks=logAmount>=.5?
    (MAX===20000?[0,20,50,100,200,500,1000,2000,5000,10000,20000]:[0,20,50,100,200,500,1000,2000]):
    (MAX===20000?[0,5000,10000,15000,20000]:[0,500,1000,1500,2000]);
  let lastTick=-Infinity;
  for(const value of ticks){
    const xx=x(value),yy=y(value);
    if(xx-lastTick<27*ratio&&value!==MAX)continue;
    lastTick=xx;
    ctx.beginPath();ctx.moveTo(xx,top);ctx.lineTo(xx,bottom);
    ctx.moveTo(left,yy);ctx.lineTo(right,yy);ctx.stroke();
    ctx.fillStyle="#9cb7bb";
    ctx.fillText(value>=1000?(value/1000)+"k":String(value),xx,bottom+5*ratio);
    ctx.textAlign="right";ctx.textBaseline="middle";
    ctx.fillText(value>=1000?(value/1000)+"k":String(value),left-5*ratio,yy);
    ctx.textAlign="center";ctx.textBaseline="top";
  }
  ctx.setLineDash([4*ratio,5*ratio]);ctx.strokeStyle="#70878b";ctx.globalAlpha=.13+.75*(1-(settings.wet??1));
  ctx.beginPath();ctx.moveTo(left,bottom);ctx.lineTo(right,top);ctx.stroke();ctx.setLineDash([]);ctx.globalAlpha=1;
  {
    for(const [hz,label] of [[settings.low,"L"],[settings.high,"H"]]){
      if(hz<DISPLAY_MIN||hz>MAX)continue;
      const xx=x(hz);ctx.setLineDash([3*ratio,3*ratio]);ctx.strokeStyle="#e1b67b";
      ctx.beginPath();ctx.moveTo(xx,top);ctx.lineTo(xx,bottom);ctx.stroke();ctx.setLineDash([]);
      ctx.fillStyle="#e1b67b";ctx.fillText(label,xx,top+4*ratio);
    }
  }
  // Explicit pivot/anchor (not a generic "reference" hidden in F/m).
  // Same physical square scale is used on x and y.
  if(settings.axisPivot>=DISPLAY_MIN && settings.axisPivot<=MAX){
    const xx=x(settings.axisPivot);
    ctx.save();ctx.setLineDash([3*ratio,5*ratio]);ctx.strokeStyle="#ffd37e";
    ctx.beginPath();ctx.moveTo(xx,top);ctx.lineTo(xx,bottom);ctx.stroke();
    ctx.restore();ctx.fillStyle="#ffd37e";ctx.textAlign="center";
    ctx.fillText("起点",xx,top+5*ratio);
  }
  // Pixel-uniform sampling is essential when the x axis is logarithmic.
  // A linear 512-bin frequency grid gave almost no line detail below 100 Hz
  // in the 20 kHz view despite spreading that range across much of the plot.
  const inversePosition=t=>{
    if(amount===0)return MAX*t;
    if(amount===1)return 20*Math.expm1(Math.log1p(MAX/20)*t);
    let lower=0,upper=MAX;
    for(let j=0;j<20;j++){
      const mid=(lower+upper)/2;
      if(position(mid)<t)lower=mid;else upper=mid;
    }
    return (lower+upper)/2;
  };
  const rows=graphSegments(settings,warp,translate,MAX,inversePosition);
  const crushing=settings.crusherBits>0&&(settings.crusherHold>1||settings.crusherHold===0);
  const effectiveHz=settings.crusherHold>0?
    settings.sampleRate/settings.crusherHold:0;
  if(crushing){
    // Horizontal mirror boundaries in the ACTUAL output-frequency axis:
    // the fundamental Nyquist reflection is y=F_hold/2.
    const mirror=effectiveHz/2;
    if(effectiveHz>0&&mirror<=MAX){
      ctx.save();ctx.strokeStyle="#f2bb79";ctx.lineWidth=.7*ratio;
      for(let m=0;m<8;m++){
        const frequency=(m+.5)*effectiveHz;
        if(frequency>MAX)break;
        ctx.globalAlpha=m===0?.65:.18;
        const yy=y(frequency);
        ctx.beginPath();ctx.moveTo(left,yy);ctx.lineTo(right,yy);ctx.stroke();
        if(m===0){ctx.globalAlpha=.92;ctx.fillStyle="#f2bb79";
          ctx.font=(9*ratio)+"px system-ui";ctx.textAlign="left";
          ctx.fillText("y="+Number(mirror.toFixed(2))+"Hz (Fs′/2)",left+3*ratio,yy-8*ratio);
        }
      }
      ctx.restore();
    }else if(effectiveHz===0){
      // At zero update frequency the actual held result is DC, not an
      // audio-frequency tone. DC lies at the true graph origin.
      ctx.save();ctx.strokeStyle="#f2bb79";ctx.lineWidth=1.2*ratio;
      ctx.globalAlpha=.7;ctx.beginPath();ctx.moveTo(left,bottom);
      ctx.lineTo(right,bottom);ctx.stroke();
      ctx.fillStyle="#f2bb79";ctx.font=(9*ratio)+"px system-ui";
      ctx.fillText("y=0Hz / sample frozen",left+3*ratio,bottom-8*ratio);
      ctx.restore();
    }
  }

  const wet=Math.min(1,Math.max(0,settings.wet??1));
  // Real PCM has multiple images after the held-sample step.
  // For visual legibility we plot baseband + two adjacent images and
  // an optional pre-crusher k=0 image; each uses the correct |H_N|.
  // These are representative EXACT sinusoidal kernel lines only, not a
  // complete spectrum of arbitrary audio after nonlinear quantization.
  const imageOffsets=crushing&&effectiveHz>0?
    [{delta:0,primary:true},{delta:-1,primary:false},
      {delta:1,primary:false},{delta:-2,primary:false},
      {delta:2,primary:false},{direct:true,primary:false}]:
    [{primary:true}];
  for(let channel=0;channel<(settings.ringEnabled?2:1);channel++){
    for(const imageVariant of imageOffsets){
      ctx.save();ctx.lineWidth=(imageVariant.primary?1.35:.85)*ratio;
      ctx.strokeStyle=imageVariant.primary?
        (channel===0?"#66e9ba":"#f0b97b"):"#e5a769";
      let previous=null;
      for(const point of rows){
        const before=point.outputs[channel];
        if(!Number.isFinite(before)){previous=null;continue;}
        const ampAfterReflect=point.reflected?
          Math.max(0,Math.min(1,point.reflectionGain??1)):1;
        const ringSideband=settings.ringEnabled&&point.inside?.5:1;
        let outputHz=before,amplitude=1,order=0;
        if(crushing&&effectiveHz>0){
          const baseOrder=-Math.round(before/effectiveHz);
          order=imageVariant.direct?0:baseOrder+(imageVariant.delta||0);
          if(imageVariant.direct&&order===baseOrder){previous=null;continue;}
          const image=sampleHoldImage(before,order,settings.sampleRate,settings.crusherHold);
          outputHz=image.frequency;amplitude=image.amplitude;
        }
        if(!Number.isFinite(outputHz)||outputHz<0||outputHz>MAX ||
          amplitude<1e-5){previous=null;continue;}
        const gain=wet*ampAfterReflect*ringSideband*amplitude;
        const current={x:x(point.f),y:y(outputHz),gain,order,
          inside:point.inside,reflected:Boolean(point.reflected)};
        if(previous&&previous.order===current.order&&
           previous.inside===current.inside &&
           previous.reflected===current.reflected &&
           Math.abs(current.y-previous.y)<height*.32){
          ctx.globalAlpha=Math.min(1,(current.gain+previous.gain)/2);
          if(ctx.globalAlpha>1e-4){
            ctx.beginPath();ctx.moveTo(previous.x,previous.y);
            ctx.lineTo(current.x,current.y);ctx.stroke();
          }
        }
        previous=current;
      }
      ctx.restore();
    }
  }
  ctx.globalAlpha=1;
  ctx.fillStyle="#b4c6c5";ctx.font=(11*ratio)+"px system-ui";
  ctx.textAlign="center";ctx.textBaseline="alphabetic";
  ctx.fillText("Input f (Hz)",(left+right)/2,size-3*ratio);
  ctx.save();ctx.translate(11*ratio,(top+bottom)/2);ctx.rotate(-Math.PI/2);
  ctx.fillText("Output f′ (Hz)",0,0);ctx.restore();
}
