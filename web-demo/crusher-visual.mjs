/** Numeric control adapters; the actual processed audio is common native/WASM Rust.
 * Requested sample update rate is 0..Fs. Exactly 0 means freeze the
 * first post-effect sample, NOT a zero-length sample period.
 */
const MAX_HOLD=1_000_000_000;
export function frequencyFromSlider(position,sampleRate){
  const rate=Math.max(1,Number(sampleRate)||48000);
  const t=Math.max(0,Math.min(1,Number(position)/1000));
  return t===0?0:rate*Math.pow(1e-5,1-t);
}
export function sliderPositionFromFrequency(hz,sampleRate){
  const rate=Math.max(1,Number(sampleRate)||48000);
  if(!(hz>0))return 0;
  return 1000*Math.max(0,Math.min(1,
    1+Math.log(Math.min(rate,hz)/rate)/Math.log(1e5)));
}
export function sliderFromFrequency(hz,sampleRate){
  const rate=Math.max(1,Number(sampleRate)||48000);
  if(!(hz>0))return 0;
  return Math.round(sliderPositionFromFrequency(hz,rate));
}
export function holdFromFrequency(hz,sampleRate){
  const rate=Math.max(1,Number(sampleRate)||48000);
  if(!Number.isFinite(hz)||hz<=0)return 0;
  return Math.max(1,Math.min(MAX_HOLD,Math.round(rate/Math.min(rate,hz))));
}
export function effectiveFrequency(hz,sampleRate){
  const n=holdFromFrequency(hz,sampleRate);
  return n===0?0:sampleRate/n;
}
/** Spectral fold into discrete time [0, Fs/2], with NO amplitude claim. */
export function foldToNyquist(f,rate){
  if(!(rate>0)||!Number.isFinite(f))return NaN;
  const unit=((f+rate/2)%rate+rate)%rate;
  return Math.abs(unit-rate/2);
}
export function aliasFrequency(inputHz,sampledHz){
  return foldToNyquist(inputHz,sampledHz);
}
/** One exact spectral line from linear N-sample sample/hold of a COMPLEX
 * sinusoid, before nonlinear quantization. A real sine consists of +/- f
 * conjugate lines. Output images are at (f + k Fs/N) modulo the hardware Fs.
 * H_N(f_image)=|sin(pi*N*f_image/Fs)/(N*sin(pi*f_image/Fs))|.
 * This is the true *discrete-time zero-order-hold* response, not sinc
 * interpolation and not a made-up estimated volume of a song.
 */
export function sampleHoldImage(inputHz,imageOrder,sampleRate,hold){
  if(!(sampleRate>0)||!Number.isFinite(inputHz)||hold<1||!Number.isInteger(hold)){
    return {frequency:NaN,amplitude:0,order:imageOrder};
  }
  const signed=inputHz+imageOrder*sampleRate/hold;
  const folded=foldToNyquist(signed,sampleRate);
  const norm=signed/sampleRate;
  const den=Math.sin(Math.PI*norm);
  const amplitude=Math.abs(den)<1e-12?
    1:Math.abs(Math.sin(Math.PI*hold*norm)/(hold*den));
  return {frequency:folded,amplitude:Math.min(1,amplitude),order:imageOrder};
}
/** Representative spectral images: include the baseband alias and local
 * adjacent image orders. Never claim this sparse set is an exhaustive FFT.
 */
export function sampleHoldRepresentatives(f,sampleRate,hold){
  if(!Number.isFinite(f)||!(hold>=1))return [];
  const baseOrder=-Math.round(f/(sampleRate/hold));
  const orders=new Set([baseOrder-2,baseOrder-1,baseOrder,baseOrder+1,
    baseOrder+2,0,-1,1]);
  return [...orders].slice(0,9).map(k=>sampleHoldImage(f,k,sampleRate,hold))
    .filter(x=>Number.isFinite(x.frequency)&&x.amplitude>0.00005);
}
/** Synthetic 4.3-cycle wave. Thin guides show exactly where Rust's
 * integer-sample history is held and where amplitude quantization occurs.
 * This is NOT a visualized loaded file or measured spectral recording.
 */
export function drawCrusherPreview(canvas,{bits=0,hold=1,sampleRate=48000,ringEnabled=false,carrierHz=0}={}){
  if(!canvas)return;
  const ctx=canvas.getContext("2d");
  const w=Math.max(240,Math.round(canvas.getBoundingClientRect().width||300));
  const h=90;canvas.width=w;canvas.height=h;
  const length=192,cycles=4.3;
  const plot={left:28,right:w-7,top:31,bottom:h-16};
  const scaleX=i=>plot.left+i*(plot.right-plot.left)/(length-1);
  const scaleY=y=>plot.top+(1-y)*(plot.bottom-plot.top)/2;
  // The blue source is a synthetic reference, NOT decoded file samples.
  // Ring modulation multiplies that signed sample by cos(2π c t).
  const raw=i=>0.77*Math.sin(2*Math.PI*cycles*i/length);
  const ringed=i=>ringEnabled?raw(i)*Math.cos(2*Math.PI*carrierHz*i/sampleRate):raw(i);
  const levels=2**(Math.max(2,bits)-1);
  const held=i=>ringed(hold===0?0:Math.floor(i/Math.max(1,hold))*Math.max(1,hold));
  const rounded=i=>!bits?ringed(i):Math.round(held(i)*levels)/levels;
  ctx.clearRect(0,0,w,h);
  ctx.strokeStyle="#49676b";ctx.lineWidth=1;ctx.beginPath();
  ctx.moveTo(plot.left,plot.top);ctx.lineTo(plot.left,plot.bottom);
  ctx.lineTo(plot.right,plot.bottom);ctx.stroke();
  ctx.beginPath();ctx.moveTo(plot.left,scaleY(0));ctx.lineTo(plot.right,scaleY(0));ctx.stroke();
  if(bits){
    // Quantizer memory: draw faint horizontal integer amplitude levels.
    // As bits decrease, the steps are fewer and become visibly coarser.
    const guides=Math.min(levels*2,64);
    const stride=Math.max(1,Math.ceil(levels*2/guides));
    ctx.strokeStyle="rgba(255,189,105,.12)";ctx.lineWidth=.6;
    for(let q=-levels;q<=levels;q+=stride){
      const value=q/levels;if(value<-.8||value>.8)continue;
      const y=scaleY(value);ctx.beginPath();ctx.moveTo(plot.left,y);
      ctx.lineTo(plot.right,y);ctx.stroke();
    }
    // Sample history: faint clock-grid strokes and sampled level markers.
    if(hold===0){
      ctx.fillStyle="rgba(255,189,105,.22)";ctx.fillRect(plot.left,plot.top,1,plot.bottom-plot.top);
    }else if(hold>1){
      const delta=Math.max(1,Math.floor(hold));
      ctx.strokeStyle="rgba(255,189,105,.18)";ctx.lineWidth=.65;
      for(let i=0;i<length;i+=delta){
        const x=scaleX(i),v=Math.round(ringed(i)*levels)/levels;
        ctx.beginPath();ctx.moveTo(x,plot.top);ctx.lineTo(x,plot.bottom);ctx.stroke();
        ctx.fillStyle="rgba(255,189,105,.3)";
        ctx.fillRect(x-1,scaleY(v)-1.5,3,3);
      }
    }
  }
  ctx.strokeStyle="#78969a";ctx.lineWidth=1.25;ctx.beginPath();
  for(let i=0;i<length;i++){
    if(i===0)ctx.moveTo(scaleX(i),scaleY(raw(i)));
    else ctx.lineTo(scaleX(i),scaleY(raw(i)));
  }ctx.stroke();
  ctx.strokeStyle="#ffbd69";ctx.lineWidth=1.55;ctx.beginPath();
  for(let i=0;i<length;i++){
    if(i===0)ctx.moveTo(scaleX(i),scaleY(rounded(i)));
    else ctx.lineTo(scaleX(i),scaleY(rounded(i)));
  }ctx.stroke();
  ctx.font="9px system-ui,sans-serif";ctx.textBaseline="middle";
  ctx.fillStyle="#c2d2cf";ctx.fillText("振幅（正規化）",3,23);
  ctx.fillStyle="#a9c1bc";ctx.fillText("サンプル",w-51,h-4);
  const legendY=11;
  ctx.lineWidth=2;ctx.strokeStyle="#78969a";ctx.beginPath();
  ctx.moveTo(7,legendY);ctx.lineTo(15,legendY);ctx.stroke();
  ctx.fillStyle="#c2d2cf";ctx.fillText("原音",19,legendY);
  ctx.strokeStyle="#ffbd69";ctx.beginPath();
  ctx.moveTo(45,legendY);ctx.lineTo(53,legendY);ctx.stroke();
  ctx.fillStyle="#ffd49e";ctx.fillText("加工後",57,legendY);
  ctx.strokeStyle="#e5a959";ctx.lineWidth=1;ctx.beginPath();
  ctx.moveTo(96,legendY);ctx.lineTo(104,legendY);
  ctx.moveTo(100,legendY-2);ctx.lineTo(100,legendY+2);ctx.stroke();
  ctx.fillStyle="#e4bf92";ctx.fillText("保持/量子化",102,legendY);
}
