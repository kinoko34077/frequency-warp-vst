import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {createWasmStreamedRenderSource} from "./wasm-stream-export.mjs";
import {encodePcm16Wav} from "./wav-stream-writer.mjs";

const settings={
 low:20,high:3500,curvature:1,invert:0.35,mode:"blend",
 outside:"pass",qualityIndex:0,engine:0,hopDiv:4,
 pitchRatio:1,shiftHz:0,carrierHz:0,zeroMode:0,
 zeroReflectGain:1,zeroReflectDecay:0,
 axisShift:0,axisReference:350,axisPivot:350,axisSlope:1,
 ringEnabled:false,rationalEnabled:false,crusherBits:0,crusherRateHz:4096,
 aMinHz:20,aReverb:0,aBandBins:1,aQuality:0
};
async function wasm(){
 const bytes=await readFile("web-demo/dsp_core.wasm");
 return (await WebAssembly.instantiate(bytes,{})).instance.exports;
}
function samples(frames,rate){
 return Float32Array.from({length:frames},(_,i)=>0.3*Math.sin(2*Math.PI*330*i/rate)+
  0.17*Math.sin(2*Math.PI*731*i/rate));
}
test("streamed Rust PCM equals legacy whole-file Rust audio on actual WASM",async()=>{
 const rate=8192,frames=8193,signal=samples(frames,rate),calls=[];
 const source={info:{frames,channels:1,sampleRate:rate},
   async readFrames(start,count){calls.push(count);return [signal.subarray(start,start+count)];}};
 const e=await wasm();
 const streamed=createWasmStreamedRenderSource(e,source,settings);
 const actual=new Float32Array(frames);
 for(let at=0;at<frames;at+=512){
   const n=Math.min(512,frames-at);
   actual.set((await streamed.readFrames(at,n))[0],at);
 }
 assert.equal(streamed.consumedFrames,frames);
 assert.ok(calls.every(n=>n<=8192),"reader must never require a full source buffer");
 const src=e.warp_alloc_f32(frames),dst=e.warp_alloc_f32(frames);
 try{
   new Float32Array(e.memory.buffer,src,frames).set(signal);
   const result=e.warp_stream_render_f32_zero_controls_rate_ext(
    src,dst,frames,1,rate,settings.low,settings.high,settings.curvature,
    settings.invert,1,settings.qualityIndex,1,settings.engine,
    settings.pitchRatio,settings.shiftHz,settings.carrierHz,settings.zeroMode,
    settings.hopDiv,settings.crusherBits,2,settings.axisShift,
    settings.axisReference,0,0,settings.axisPivot,settings.axisSlope,
    settings.aMinHz,settings.aReverb,settings.aBandBins,settings.aQuality,
    settings.zeroReflectGain,settings.zeroReflectDecay,settings.crusherRateHz);
   assert.equal(result,0);
   const expected=new Float32Array(e.memory.buffer,dst,frames);
   let maxDiff=0;
   for(let i=0;i<frames;i++)maxDiff=Math.max(maxDiff,Math.abs(actual[i]-expected[i]));
   assert.ok(maxDiff<1e-5,"streamed/whole-file shared Rust output mismatch: "+maxDiff);
 }finally{e.warp_free_f32(src,frames);e.warp_free_f32(dst,frames);}
});
test("streamed Rust output pipes directly into bounded PCM16 writer",async()=>{
 const rate=8192,frames=2048,signal=samples(frames,rate);
 const source={info:{frames,channels:1,sampleRate:rate},
   async readFrames(start,count){return [signal.subarray(start,start+count)];}};
 const renderer=createWasmStreamedRenderSource(await wasm(),source,settings,{wet:.5});
 const chunks=[];
 for await(const bytes of encodePcm16Wav({
    frames,channels:1,sampleRate:rate,chunkFrames:512,
    readFrames:(start,count)=>renderer.readFrames(start,count)
 }))chunks.push(bytes);
 assert.equal(chunks.length,5);
 assert.equal(chunks[0].byteLength,44);
 assert.equal(chunks.reduce((a,b)=>a+b.byteLength,0),44+frames*2);
 assert.ok(chunks.every(x=>x.byteLength<=1024));
});
test("unsupported channel topology is explicit, not silently downmixed",async()=>{
 assert.throws(()=>createWasmStreamedRenderSource({},{
   info:{frames:3000,channels:3,sampleRate:48000},readFrames(){}},settings),/チャンネル構成/);
});
