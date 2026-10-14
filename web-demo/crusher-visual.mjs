/** Pure browser-adapter mappings. Rust receives integer hold frames; this module
 * never performs production audio synthesis. The frequency control goes
 * LOW -> HIGH Hz from left to right (opposite of the former 1 -> 32 hold UI).
 */
export function frequencyFromSlider(position,sampleRate){
  const rate=Math.max(1,Number(sampleRate)||48000);
  const t=Math.max(0,Math.min(1,Number(position)/1000));
  return rate/32*Math.pow(32,t);
}
export function sliderFromFrequency(hz,sampleRate){
  const rate=Math.max(1,Number(sampleRate)||48000);
  const ratio=Math.max(1/32,Math.min(1,Number(hz)/rate));
  return Math.round(1000*Math.log(32*ratio)/Math.log(32));
}
export function holdFromFrequency(hz,sampleRate){
  const rate=Math.max(1,Number(sampleRate)||48000);
  return Math.max(1,Math.min(32,Math.round(rate/Math.max(1,Number(hz)||rate))));
}
export function effectiveFrequency(hz,sampleRate){
  return sampleRate/holdFromFrequency(hz,sampleRate);
}
/** Zero-order hold aliases the sampled baseband carrier to [-Fs'/2,Fs'/2].
 * This displays possible ALIAS FREQUENCIES, never spur amplitude estimates.
 */
export function aliasFrequency(inputHz,sampledHz){
  if(!(sampledHz>0&&Number.isFinite(inputHz)))return NaN;
  const unit=((inputHz+sampledHz/2)%sampledHz+sampledHz)%sampledHz;
  return Math.abs(unit-sampledHz/2);
}
/** Audition aid: draw a deliberately synthetic sine and its sample-held,
 * amplitude-quantized form. Not a measured recording or frequency response.
 */
export function drawCrusherPreview(canvas,{bits=0,hold=1,sampleRate=48000}={}){
  if(!canvas)return;
  const ctx=canvas.getContext("2d");
  const w=Math.max(240,Math.round(canvas.getBoundingClientRect().width||300));
  const h=90;canvas.width=w;canvas.height=h;
  const length=192,cycles=4.3;
  const scaleX=i=>i*w/(length-1);
  const scaleY=y=>h/2-y*(h*.39);
  const raw=i=>0.77*Math.sin(2*Math.PI*cycles*i/length);
  const rounded=i=>{
    if(!bits)return raw(i);
    const levels=2**(bits-1),source=Math.floor(i/hold)*hold;
    return Math.round(raw(source)*levels)/levels;
  };
  ctx.clearRect(0,0,w,h);
  ctx.strokeStyle="#49676b";ctx.lineWidth=1;ctx.beginPath();
  ctx.moveTo(0,h/2);ctx.lineTo(w,h/2);ctx.stroke();
  ctx.strokeStyle="#78969a";ctx.lineWidth=1.3;ctx.beginPath();
  for(let i=0;i<length;i++){
    const px=scaleX(i),py=scaleY(raw(i));
    if(i===0)ctx.moveTo(px,py);else ctx.lineTo(px,py);
  }ctx.stroke();
  ctx.strokeStyle="#ffbd69";ctx.lineWidth=1.5;ctx.beginPath();
  for(let i=0;i<length;i++){
    const px=scaleX(i),py=scaleY(rounded(i));
    if(i===0)ctx.moveTo(px,py);else ctx.lineTo(px,py);
  }ctx.stroke();
}
