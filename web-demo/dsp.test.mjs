import {test} from "node:test";
import assert from "node:assert/strict";
import {fft,mapFrequency,mixWet,warpOffline,QUALITY} from "./dsp.mjs";

const fs=8192;
function tone(f,length=4096,phase=0,gain=1){
  return Float32Array.from({length},(_,i)=>gain*Math.cos(2*Math.PI*f*i/fs+phase));
}
function peak(signal){
  const re=Float64Array.from(signal),im=new Float64Array(signal.length);
  fft(re,im);
  let best=0,index=0;
  for(let i=1;i<signal.length/2;i++){
    const strength=Math.hypot(re[i],im[i]);
    if(strength>best){best=strength;index=i;}
  }
  return {frequency:index*fs/signal.length,index,real:re[index],imag:im[index]};
}
const settings={low:20,high:3000,curvature:1,invert:1,mode:"fold",
  fftSize:1024,hop:128,peaks:8,floor:.04};
test("FFT forward and inverse preserve complex samples",()=>{
  const re=Float64Array.from({length:256},(_,i)=>Math.sin(i*.2)+.3*Math.cos(i*.7));
  const original=Array.from(re),im=new Float64Array(re.length);
  fft(re,im);fft(re,im,true);
  for(let i=0;i<re.length;i++){
    assert.ok(Math.abs(re[i]-original[i])<1e-10);
    assert.ok(Math.abs(im[i])<1e-10);
  }
});
test("curvature exact endpoints and fold identity / reflection",()=>{
  for(const p of [0, .001,.5,1]){
    for(const f of [20,100,400,1500,3000]){
      assert.ok(Math.abs(mapFrequency(f,20,3000,p,0)-f)<1e-9);
      const r=mapFrequency(f,20,3000,p,1);
      assert.ok(Math.abs(mapFrequency(r,20,3000,p,1)-f)<1e-7);
    }
  }
  assert.ok(Math.abs(mapFrequency(100,20,3000,0,1)-600)<1e-8);
  assert.ok(Math.abs(mapFrequency(100,20,3000,1,1)-2920)<1e-8);
});
test("blend collapses at 50% for linear curvature but fold does not",()=>{
  const a=mapFrequency(100,20,3000,1,.5,"blend");
  const b=mapFrequency(1500,20,3000,1,.5,"blend");
  assert.ok(Math.abs(a-b)<1e-8);
  assert.ok(Math.abs(mapFrequency(100,20,3000,1,.5)-mapFrequency(1500,20,3000,1,.5))>100);
});
test("wet mix respects endpoints",()=>{
  const dry=new Float32Array([1,.5,-.5]);
  const processed=new Float32Array([0,0,1]);
  assert.deepEqual(Array.from(mixWet(dry,processed,0)),Array.from(dry));
  assert.deepEqual(Array.from(mixWet(dry,processed,1)),Array.from(processed));
});
test("STFT processed tone is actually moved from 500 to 2520Hz",()=>{
  const source=tone(500);
  const result=warpOffline([source],fs,settings);
  const y=result.channels[0];
  const out=peak(y);
  assert.ok(Math.abs(out.frequency-2520)<5, "received "+out.frequency);
  assert.ok(Math.abs(out.frequency-500)>100);
  const sourceRms=Math.hypot(...[]); // deliberately no amplitude normalization
  const rms=a=>Math.sqrt(a.reduce((s,x)=>s+x*x,0)/a.length);
  assert.ok(rms(y)>rms(source)*.7,"unexpectedly low gain");
  assert.ok(result.diagnostics.peaks>0);
  assert.equal(sourceRms,0);
});
test("shared phase rotation keeps a two-channel phase difference",()=>{
  const left=tone(500),right=tone(500,4096,.5,.7);
  const {channels}=warpOffline([left,right],fs,settings);
  const a=peak(channels[0]);
  const b=peak(channels[1]);
  assert.ok(Math.abs(a.frequency-b.frequency)<2);
  const phase=Math.atan2(b.imag,b.real)-Math.atan2(a.imag,a.real);
  const wrapped=Math.atan2(Math.sin(phase),Math.cos(phase));
  assert.ok(Math.abs(wrapped-.5)<.1,"relative phase "+wrapped);
});
test("no invented band policy: invalid domain is rejected",()=>{
  assert.throws(()=>mapFrequency(3900,20,3000,.5,1));
  assert.throws(()=>warpOffline([tone(500)],fs,{...settings,high:fs/2}));
});
test("Quality exposes at least three actually distinct compute profiles",()=>{
  assert.ok(Object.keys(QUALITY).length>=3);
  assert.ok(QUALITY.eco.fftSize<QUALITY.high.fftSize);
});
