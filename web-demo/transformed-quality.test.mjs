import {test} from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {toneComponentQuality,stereoImageQuality,qualityGate,transientOnsetQuality} from "./acoustic-quality.mjs";

/** #299 M3 bounded transformed-domain scorecard.
 * Unlike an identity waveform test, the oracle here KNOWS a constant
 * source component at 480 Hz must be mapped to 504 Hz by +24 Hz rational
 * translation. Broadband noise is deliberately not assigned a "correct"
 * output waveform. Test records a candidate's failures without laundering
 * them into a fictitious perceptual MOS or failing instrumentation itself.
 */
test("same actual Rust/WASM mapped stereo fixture distinguishes target, ghost and image",async()=>{
  const binary=await readFile("web-demo/dsp_core.wasm");
  const {instance}=await WebAssembly.instantiate(binary,{});
  const e=instance.exports,fs=8192,frames=8192,channels=2,count=frames*channels;
  assert.equal(typeof e.warp_stream_render_f32_a_quality_ext,"function");
  const src=e.warp_alloc_f32(count),dst=e.warp_alloc_f32(count);
  assert.ok(src&&dst);
  let seed=47201;
  const noise=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;
    return seed/0x80000000-1;};
  const source=new Float32Array(count);
  for(let i=0;i<frames;i++){
    const mono=.35*Math.cos(2*Math.PI*480*i/fs)+.04*noise();
    source[i]=mono;source[i+frames]=.6*mono;
  }
  const range={start:2400,end:7300};
  const sourceStats=toneComponentQuality(source.subarray(0,frames),
    {sampleRate:fs,targetHz:504,sourceHz:480,...range});
  assert.ok(sourceStats.ghostToTargetDb>15,
    "negative control: original 480Hz source must NOT pass 504Hz oracle");
  const scorecards=[];
  try{
    new Float32Array(e.memory.buffer,src,count).set(source);
    for(const candidate of [
      {engine:0,aQuality:0,name:"A_peak_only"},
      {engine:0,aQuality:100,name:"A_partial_residual"},
      {engine:1,aQuality:0,name:"B_fft_bins"}
    ]){
      const start=performance.now();
      const result=e.warp_stream_render_f32_a_quality_ext(
        src,dst,frames,channels,fs,20,3000,1,0,1,0,1,
        candidate.engine,1,24,0,0,4,0,1,0,350,0,1,350,1,20,0,1,candidate.aQuality);
      assert.equal(result,0,"actual DSP invocation failed "+candidate.name);
      const elapsedMs=performance.now()-start;
      const out=Float32Array.from(new Float32Array(e.memory.buffer,dst,count));
      assert.ok(out.every(Number.isFinite),"nonfinite real PCM "+candidate.name);
      const tone=toneComponentQuality(out.subarray(0,frames),
        {sampleRate:fs,targetHz:504,sourceHz:480,...range});
      const stereo=stereoImageQuality(
        source.subarray(0,frames),source.subarray(frames),
        out.subarray(0,frames),out.subarray(frames),range);
      const knownPartial=qualityGate(tone,{
        targetAmplitude:{min:.1},
        ghostToTargetDb:{max:-12}
      });
      const spatial=qualityGate(stereo,{
        ildErrorDb:{min:-.25,max:.25},
        correlationDelta:{min:-.02,max:.02}
      });
      scorecards.push({
        candidate: candidate.name,
        actualRustWasm:true,
        map:{sourceHz:480,targetHz:504,shiftHz:24,rationalEnabled:true},
        renderedSamples:count,rate:fs,channels,latencyCompensatedOffline:true,
        aQuality:candidate.aQuality,
        expectedToneAmplitude:sourceStats.sourceGhostAmplitude,
        tone,stereo:{
          ildErrorDb:stereo.ildErrorDb,
          correlationDelta:stereo.correlationDelta,
          sideEnergyRatio:stereo.sideEnergyRatio
        },
        oracleKnownPartialVerdict:knownPartial,
        spatialFixtureVerdict:spatial,
        wasmElapsedMs:Number(elapsedMs.toFixed(3)),
        caveat:"WASM wall time not realtime host CPU and not perceptual MOS; no noise-waveform oracle"
      });
    }
    assert.equal(scorecards.length,3);
    assert.ok(scorecards.every(row=>row.tone.targetAmplitude>=0),
      "all candidates must actually be evaluated");
    console.log("TRANSFORMED_RUST_WASM_QUALITY_AXES "+JSON.stringify(scorecards));
  }finally{
    e.warp_free_f32(src,count);e.warp_free_f32(dst,count);
  }
});

test("same real Rust/WASM rendered mapped gated onset reports attack, pre-echo and lag",async()=>{
  const binary=await readFile("web-demo/dsp_core.wasm");
  const {instance}=await WebAssembly.instantiate(binary,{});
  const e=instance.exports,fs=8192,frames=8192,onset=2048,channels=2,count=frames*channels;
  assert.equal(typeof e.warp_stream_render_f32_a_quality_ext,"function");
  const src=e.warp_alloc_f32(count),dst=e.warp_alloc_f32(count);
  assert.ok(src&&dst);
  const signal=new Float32Array(count);
  for(let i=onset;i<frames;i++){
    const v=.38*Math.cos(2*Math.PI*480*i/fs);
    signal[i]=v;signal[frames+i]=v*.6;
  }
  const cfg={sampleRate:fs,onsetSample:onset,preSamples:512,
    attackSamples:512,blockSamples:16};
  const dry=transientOnsetQuality(signal.subarray(0,frames),
    signal.subarray(0,frames),cfg);
  const threshold={onsetOffsetMs:{min:-8,max:8},
    preEchoDb:{max:-25},attackRmsRatio:{min:.7,max:1.3}};
  assert.equal(qualityGate(dry,threshold).pass,true,
    "known good original must pass the transformed-onset diagnostic baseline");
  const rows=[];
  try{
    for(const candidate of [
      {engine:0,aQuality:0,name:"A_peak_only"},
      {engine:0,aQuality:100,name:"A_partial_residual"},
      {engine:1,aQuality:0,name:"B_fft_bins"}
    ]){
      new Float32Array(e.memory.buffer,src,count).set(signal);
      const status=e.warp_stream_render_f32_a_quality_ext(
        src,dst,frames,channels,fs,20,3000,1,0,1,0,1,
        candidate.engine,1,24,0,0,4,0,1,0,350,0,1,350,1,20,0,1,candidate.aQuality);
      assert.equal(status,0,"Rust/WASM gated transform failed "+candidate.name);
      const out=Float32Array.from(new Float32Array(e.memory.buffer,dst,count));
      assert.ok(out.every(Number.isFinite),candidate.name+" generated nonfinite PCM");
      const channelAxes=[0,1].map(channel=>transientOnsetQuality(
        signal.subarray(channel*frames,(channel+1)*frames),
        out.subarray(channel*frames,(channel+1)*frames),cfg));
      const verdicts=channelAxes.map(axes=>qualityGate(axes,threshold));
      rows.push({candidate:candidate.name,sampleRate:fs,channels,
        map:{sourceHz:480,targetHz:504,shiftHz:24},
        latencyCompensatedOffline:true,
        sourceGate:onset,
        measured:channelAxes,transientVerdicts:verdicts,
        limitations:"Known isolated gated source only; no universal pre-echo audibility or human preference score"});
    }
    assert.equal(rows.length,3);
    assert.ok(rows.every(v=>v.measured.length===2&&
      v.measured.every(x=>Number.isFinite(x.attackRmsRatio))));
    console.log("TRANSFORMED_RUST_WASM_ONSET_QUALITY "+JSON.stringify(rows));
  }finally{
    e.warp_free_f32(src,count);e.warp_free_f32(dst,count);
  }
});
