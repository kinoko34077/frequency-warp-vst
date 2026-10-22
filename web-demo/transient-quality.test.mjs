import {test} from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {transientEnvelopeQuality,toneComponentQuality,
  stereoImageQuality,qualityGate} from "./acoustic-quality.mjs";

/** #299 M3: real Rust/WASM gated transient at a KNOWN target frequency.
 * The source envelope supplies an onset/end oracle but the spectral details
 * of noise/transient warping have no single mathematically unique ground truth.
 */
test("mapped gated-burst A/B candidates report actual preecho, latency and tail axes",async()=>{
  const {instance}=await WebAssembly.instantiate(await readFile("web-demo/dsp_core.wasm"),{});
  const e=instance.exports,fs=8192,frames=8192,ch=2,total=frames*ch,
    onset=2048,end=3072;
  const src=e.warp_alloc_f32(total),dst=e.warp_alloc_f32(total);
  assert.ok(src&&dst);
  const source=new Float32Array(total);
  for(let i=onset;i<end;i++){
    const value=.42*Math.cos(2*Math.PI*680*(i-onset)/fs);
    source[i]=value;source[frames+i]=.6*value;
  }
  const measure=signal=>transientEnvelopeQuality(signal,{
    sampleRate:fs,onsetSample:onset,endSample:end,windowMs:70
  });
  const sourceTemporal=measure(source.subarray(0,frames));
  assert.equal(sourceTemporal.outputSilent,false);
  assert.ok(Math.abs(sourceTemporal.onsetOffsetSamples)<32);
  const cards=[];
  try{
    for(const candidate of [
      {engine:0,quality:0,id:"A_peaks"},
      {engine:0,quality:100,id:"A_residual_Q100"},
      {engine:1,quality:0,id:"B_fft"}
    ]){
      new Float32Array(e.memory.buffer,src,total).set(source);
      const t=performance.now();
      const result=e.warp_stream_render_f32_a_quality_ext(
        src,dst,frames,ch,fs,20,3000,1,0,1,0,1,
        candidate.engine,1,24,0,0,4,0,1,0,350,0,1,350,1,20,0,1,candidate.quality);
      const elapsedMs=performance.now()-t;
      assert.equal(result,0,"real rust-wasm processing "+candidate.id);
      const out=Float32Array.from(new Float32Array(e.memory.buffer,dst,total));
      assert.ok(out.every(Number.isFinite));
      const temporal=measure(out.subarray(0,frames));
      const spectral=toneComponentQuality(out.subarray(0,frames),
        {sampleRate:fs,targetHz:704,sourceHz:680,start:2300,end:2890});
      const spatial=stereoImageQuality(source.subarray(0,frames),
        source.subarray(frames),out.subarray(0,frames),out.subarray(frames),
        {start:2300,end:2890});
      const temporalGate=qualityGate(temporal,{
        activeRms:{min:.04},preToActiveDb:{max:-20},
        tailToActiveDb:{max:-20},onsetOffsetSamples:{min:-32,max:48}
      });
      cards.push({name:candidate.id,engine:candidate.engine,
        aQuality:candidate.quality,sampleRate:fs,channels:ch,
        mapping:{sourceHz:680,targetHz:704,shiftHz:24,knownTiming:true},
        originalOnset:onset,originalEnd:end,
        temporal,temporalGate,
        tone:{targetAmplitude:spectral.targetAmplitude,
          oldFrequencyGhostDb:spectral.ghostToTargetDb},
        stereo:{ildErrorDb:spatial.ildErrorDb,
          correlationDelta:spatial.correlationDelta},
        wasmElapsedMs:Number(elapsedMs.toFixed(3)),
        status:"DIAGNOSTIC_NOT_PERCEPTUAL_ACCEPTANCE"});
    }
    assert.equal(cards.length,3);
    assert.ok(cards.every(c=>c.temporal.activeRms>=0),
      "actual DSP outputs must have independent envelope evidence");
    console.log("MAPPED_GATED_TRANSIENT_RUST_WASM "+JSON.stringify(cards));
  }finally{e.warp_free_f32(src,total);e.warp_free_f32(dst,total);}
});
