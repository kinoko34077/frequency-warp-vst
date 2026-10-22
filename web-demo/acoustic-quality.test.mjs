import {test} from "node:test";
import assert from "node:assert/strict";
import {fullReferenceQuality,stereoImageQuality,toneComponentQuality,
  qualityGate,baselineNeutralContract,transientOnsetQuality} from "./acoustic-quality.mjs";

const N=4096,rate=8192;
const clean=Float32Array.from({length:N},(_,i)=>
  .4*Math.sin(2*Math.PI*256*i/rate)+.2*Math.sin(2*Math.PI*701*i/rate));
const gate=(a,c=baselineNeutralContract)=>qualityGate(fullReferenceQuality(clean,a),c);

test("transparent input passes and deterministic adverse injections cannot game reference gates",()=>{
  assert.equal(gate(clean).pass,true);
  const mute=new Float32Array(N);
  assert.equal(gate(mute).pass,false,"silence is not fidelity");
  assert.equal(gate(Float32Array.from(clean,v=>v*.4)).pass,false,"gain loss is audible damage");
  assert.equal(gate(Float32Array.from(clean,v=>v*1.3)).pass,false,"gain boost is not accuracy");
  const moved=Float32Array.from(clean,(_,i)=>clean[(i-37+N)%N]);
  assert.equal(gate(moved).pass,false,"time shift without an allowed alignment fails");
  const clipped=Float32Array.from(clean,v=>Math.max(-.25,Math.min(.25,v)));
  assert.equal(gate(clipped).pass,false,"clipping/in-range soft limiting changes spectrum");
  const dropped=Float32Array.from(clean,(v,i)=>i>=N/2&&i<N*.75?0:v);
  assert.equal(gate(dropped).pass,false,"dropout cannot pass");
  assert.throws(()=>fullReferenceQuality(new Float32Array(N),mute),/silent reference/);
  assert.throws(()=>fullReferenceQuality(clean,Float32Array.from(clean,(v,i)=>
    i===100?NaN:v)),/non-finite/);
});
test("gain, correlation and distortion remain separate; no arbitrary combined MOS",()=>{
  const exact=fullReferenceQuality(clean,clean);
  assert.ok(exact.nrmse<1e-15);
  assert.ok(Math.abs(exact.gainDb)<1e-12);
  assert.ok(Math.abs(exact.correlation-1)<1e-12);
  const inverted=fullReferenceQuality(clean,Float32Array.from(clean,v=>-v));
  assert.ok(Math.abs(inverted.rmsGain-1)<1e-12);
  assert.ok(inverted.correlation<-.999);
  assert.ok(inverted.nrmse>1.999,"polarity flip must not pass only on RMS gain");
  assert.equal(qualityGate(inverted,baselineNeutralContract).pass,false);
});
test("stereo collapse and left/right gain change are visible independently",()=>{
  const inputR=Float32Array.from(clean,(v,i)=>
    .6*v+.05*Math.sin(2*Math.PI*1100*i/rate));
  const source=stereoImageQuality(clean,inputR,clean,inputR);
  assert.ok(Math.abs(source.ildErrorDb)<1e-12);
  assert.ok(Math.abs(source.correlationDelta)<1e-12);
  const collapsed=Float32Array.from(clean,(v,i)=>(v+inputR[i])*.5);
  const result=stereoImageQuality(clean,inputR,collapsed,collapsed);
  assert.ok(result.sideEnergyRatio<.001,"identical L/R is stereo collapse");
  assert.ok(result.correlationDelta>.001);
  const lowRight=Float32Array.from(inputR,v=>v*.5);
  const imbalance=stereoImageQuality(clean,inputR,clean,lowRight);
  assert.ok(Math.abs(imbalance.ildErrorDb+6.0205999)<.002);
});
test("tone oracle identifies deliberate target and old-frequency ghosts",()=>{
  const shifted=Float32Array.from({length:N},(_,i)=>
    .35*Math.sin(2*Math.PI*850*i/rate)+.04*Math.sin(2*Math.PI*440*i/rate));
  const valid=toneComponentQuality(shifted,{sampleRate:rate,targetHz:850,
    sourceHz:440,start:256,end:N});
  assert.ok(valid.targetAmplitude>.33);
  assert.ok(valid.ghostToTargetDb< -17,"small old-frequency ghost");
  const unshifted=toneComponentQuality(clean,{sampleRate:rate,targetHz:850,
    sourceHz:256,start:256,end:N});
  assert.ok(unshifted.ghostToTargetDb>10,"missing target is not a good transform");
});
test("criteria cannot silently pass missing data or unknown metric names",()=>{
  const q=fullReferenceQuality(clean,clean);
  assert.equal(qualityGate(q,{correlation:{min:.999}}).pass,true);
  assert.equal(qualityGate({...q,correlation:null},
    {correlation:{min:.999}}).pass,false);
  assert.throws(()=>qualityGate(q,{invented:{min:5}}),/unknown metric/);
});

test("gated-onset proxy calibrates clean, pre-echo, lag, transient-loss and silence separately",()=>{
  const fs=8192,n=8192,onset=2048;
  const ref=Float32Array.from({length:n},(_,i)=>
    i<onset?0:.4*Math.cos(2*Math.PI*480*i/fs));
  const options={sampleRate:fs,onsetSample:onset,
    preSamples:512,attackSamples:512,blockSamples:16};
  const condition={
    preEchoDb:{max:-35},
    onsetOffsetMs:{min:-2,max:2},
    attackRmsRatio:{min:.85,max:1.15}
  };
  const check=rendered=>{
    const axes=transientOnsetQuality(ref,rendered,options);
    return {axes,verdict:qualityGate(axes,condition)};
  };
  const dry=check(ref);
  assert.equal(dry.verdict.pass,true,JSON.stringify(dry));
  const before=Float32Array.from(ref);
  for(let i=onset-128;i<onset;i++)
    before[i]=.2*Math.cos(2*Math.PI*480*i/fs);
  const echo=check(before);
  assert.ok(echo.axes.onsetOffsetMs< -10);
  assert.ok(echo.axes.preEchoDb> -35);
  assert.equal(echo.verdict.pass,false);
  const delayed=Float32Array.from(ref,(_,i)=>
    i<onset+128?0:ref[i-128]);
  const lag=check(delayed);
  assert.ok(lag.axes.onsetOffsetMs>10);
  assert.equal(lag.verdict.pass,false);
  const quiet=check(Float32Array.from(ref,v=>v*.5));
  assert.ok(quiet.axes.attackRmsRatio<.6);
  assert.equal(quiet.verdict.pass,false);
  const mute=check(new Float32Array(n));
  assert.equal(mute.axes.onsetOffsetMs,null);
  assert.equal(mute.verdict.pass,false,
    "missing onset must not be rewarded as zero pre-echo");
  assert.throws(()=>transientOnsetQuality(
    Float32Array.from(ref,(v,i)=>i===1000?.1:v),ref,options),
    /before declared onset is not silent/);
  console.log("ONSET_SCORER_ADVERSARIAL "+JSON.stringify({
    dry:dry.axes,echo:echo.axes,delay:lag.axes,quiet:quiet.axes,mute:mute.axes
  }));
});
