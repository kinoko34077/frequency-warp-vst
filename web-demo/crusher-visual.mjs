/** DSP control adapter and ideal zero-order-hold (ZOH) *single-tone* spectrum.
 * The definitive sound processor is core/src/stream.rs; this file does
 * not pretend amplitude quantisation or input polyphony is a frequency map.
 */
export const MAX_CRUSHER_HOLD=1_048_576;
/** 0 exactly freezes the current audio sample until the update rate changes.
 * For positive values the logarithmic slider spans Fs/2^20 .. Fs.
 */
export function frequencyFromSlider(position,sampleRate){
  const rate=Math.max(1,Number(sampleRate)||48000);
  const pos=Math.max(0,Math.min(1000,Number(position)));
  if(pos===0)return 0;
  const t=(pos-1)/999;
  return rate*Math.exp((t-1)*Math.log(MAX_CRUSHER_HOLD));
}
export function sliderFromFrequency(hz,sampleRate){
  const rate=Math.max(1,Number(sampleRate)||48000);
  if(!(hz>0))return 0;
  const ratio=Math.max(1/MAX_CRUSHER_HOLD,Math.min(1,Number(hz)/rate));
  return Math.round(1+999*(1+Math.log(ratio)/Math.log(MAX_CRUSHER_HOLD)));
}
export function holdFromFrequency(hz,sampleRate){
  const rate=Math.max(1,Number(sampleRate)||48000);
  if(!(hz>0))return 0;
  return Math.max(1,Math.min(MAX_CRUSHER_HOLD,Math.round(rate/hz)));
}
export function effectiveFrequency(hz,sampleRate){
  const hold=holdFromFrequency(hz,sampleRate);
  return hold?sampleRate/hold:0;
}
/** Baseband alias of a *complex* tone under the sample-update lattice.
 * For zero-rate sample freezing the only steady-state output is DC.
 */
export function aliasFrequency(inputHz,sampledHz){
  if(!Number.isFinite(inputHz)||!(sampledHz>=0))return NaN;
  if(sampledHz===0)return 0;
  const unit=((inputHz+sampledHz/2)%sampledHz+sampledHz)%sampledHz;
  return Math.abs(unit-sampledHz/2);
}
/** The exact magnitude of one ZOH spectral image of a unit COMPLEX tone.
 * y[n]=x[N*floor(n/N)], x[n]=exp(j 2π f n/Fs).
 * Frequencies f+k Fs/N have coefficient |H_N(f+k Fs/N)|/N,
 * H_N(v)=Σ_{r=0}^{N-1} exp(-j 2π v r/Fs).
 * For a REAL sinusoid, positive/negative families can interfere if
 * they coincide. Clip+quantise and inter-tone collisions are NOT linear:
 * those extra harmonics are not predictable from input frequency alone.
 */
export function zohImageMagnitude(outputSignedHz,sampleRate,hold){
  if(!Number.isFinite(outputSignedHz)||!Number.isFinite(sampleRate)||
     !(sampleRate>0)||!(hold>=1))return NaN;
  if(hold===1)return 1;
  const phase=Math.PI*outputSignedHz/sampleRate;
  const denominator=Math.sin(phase);
  if(Math.abs(denominator)<1e-12)return 1;
  return Math.min(1,Math.abs(Math.sin(hold*phase)/(hold*denominator)));
}
function foldNativeNyquist(hz,fs){
  const r=((hz%fs)+fs)%fs;
  return Math.min(r,fs-r);
}
/** Return the dominant EXACT analytically located image components.
 * Not a measured spectrum. maxOrders bounds curves when N is huge.
 * Each returned image's amplitude is exact for the individual linear
 * complex-tone ZOH image; this list intentionally omits weaker images.
 */
export function sampleHoldImages(inputHz,sampleRate,hold,maxOrders=3){
  const Fs=Number(sampleRate),f=Number(inputHz);
  if(!(Fs>0)||!Number.isFinite(f)||f<0||f>Fs/2||!(hold>=0))return [];
  if(hold===0)return [{hz:0,gain:1,order:0,freeze:true}];
  if(hold===1)return [{hz:f,gain:1,order:0}];
  const feff=Fs/hold;
  const base=-Math.round(f/feff);
  const orders=new Set([base]);
  for(let m=-maxOrders;m<=maxOrders;m++)orders.add(base+m);
  orders.add(0);
  const out=[];
  for(const order of orders){
    // Distinct coefficient indices mod N. Avoid duplicate physical images
    // when a selected order differs by N or creates a native-Fs alias.
    const canonical=((order%hold)+hold)%hold;
    if(out.some(x=>x.canonical===canonical))continue;
    const signed=f+order*feff;
    out.push({hz:foldNativeNyquist(signed,Fs),
      gain:zohImageMagnitude(signed,Fs,hold),order,canonical});
  }
  return out.sort((a,b)=>b.gain-a.gain);
}
/** A deliberately synthetic time-domain sine as an educational example.
 * Faint grid shows exact sample update instants and *quantisation levels*.
 * This is not the waveform from the user's loaded song.
 */
export function drawCrusherPreview(canvas,{bits=0,hold=1,sampleRate=48000}={}){
  if(!canvas)return;
  const ctx=canvas.getContext("2d");
  const w=Math.max(240,Math.round(canvas.getBoundingClientRect().width||300));
  const h=104;canvas.width=w;canvas.height=h;
  const count=192,cycles=4.3;
  const x=i=>i*w/(count-1),y=v=>h/2-v*(h*.39);
  const raw=i=>0.77*Math.sin(2*Math.PI*cycles*i/count);
  const levels=bits>0?Math.pow(2,bits-1):1;
  const processed=i=>{
    if(!bits)return raw(i);
    const at=hold===0?0:Math.floor(i/hold)*hold;
    return Math.round(raw(at)*levels)/levels;
  };
  ctx.clearRect(0,0,w,h);
  // Coarser bit depth visibly opens up horizontal quantizer grid spacing.
  if(bits>0&&bits<=5){
    ctx.strokeStyle="rgba(247,192,118,.14)";ctx.lineWidth=1;
    for(let step=-levels;step<=levels;step++){
      const yy=y(step/levels);
      ctx.beginPath();ctx.moveTo(0,yy);ctx.lineTo(w,yy);ctx.stroke();
    }
  }
  // Lower sample update frequencies visibly spread vertical sample markers.
  if(bits>0&&(hold===0||hold>=2)){
    ctx.strokeStyle="rgba(122,190,205,.17)";ctx.lineWidth=1;
    if(hold===0){ctx.beginPath();ctx.moveTo(0,0);ctx.lineTo(0,h);ctx.stroke();}
    else for(let i=0;i<count;i+=hold){
      ctx.beginPath();ctx.moveTo(x(i),0);ctx.lineTo(x(i),h);ctx.stroke();
    }
  }
  ctx.strokeStyle="#49676b";ctx.lineWidth=1;ctx.beginPath();
  ctx.moveTo(0,h/2);ctx.lineTo(w,h/2);ctx.stroke();
  ctx.strokeStyle="#78969a";ctx.lineWidth=1.3;ctx.beginPath();
  for(let i=0;i<count;i++){const xx=x(i),yy=y(raw(i));if(!i)ctx.moveTo(xx,yy);else ctx.lineTo(xx,yy);}
  ctx.stroke();
  ctx.strokeStyle="#ffbd69";ctx.lineWidth=1.5;ctx.beginPath();
  for(let i=0;i<count;i++){const xx=x(i),yy=y(processed(i));if(!i)ctx.moveTo(xx,yy);else ctx.lineTo(xx,yy);}
  ctx.stroke();
}
