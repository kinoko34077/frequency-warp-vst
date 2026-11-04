import test from "node:test";
import assert from "node:assert/strict";
import {openWavChunkSource,WavSourceError} from "./wav-chunk-source.mjs";
import {planBufferedPreview,availableAudioMemory,planCompressedPredecode} from "./processing-capability.mjs";

function smallWav({channels=2,rate=48000,format=1,bits=16,frames=4}={}){
 const block=channels*(bits/8),ab=new ArrayBuffer(44+frames*block),v=new DataView(ab);
 const str=(o,s)=>{for(let i=0;i<s.length;i++)v.setUint8(o+i,s.charCodeAt(i));};
 str(0,"RIFF");v.setUint32(4,ab.byteLength-8,true);str(8,"WAVE");
 str(12,"fmt ");v.setUint32(16,16,true);v.setUint16(20,format,true);
 v.setUint16(22,channels,true);v.setUint32(24,rate,true);
 v.setUint32(28,rate*block,true);v.setUint16(32,block,true);v.setUint16(34,bits,true);
 str(36,"data");v.setUint32(40,frames*block,true);
 for(let i=0;i<frames;i++)for(let c=0;c<channels;c++){
  const off=44+(i*channels+c)*bits/8,value=(c===0?0.25:-0.5);
  if(format===3)v.setFloat32(off,value,true);
  else if(bits===16)v.setInt16(off,Math.round(value*32768),true);
  else if(bits===24){const sample=Math.round(value*8388608);for(let j=0;j<3;j++)v.setUint8(off+j,(sample>>8*j)&255);}
 }
 return new Blob([ab],{type:"audio/wav"});
}
test("PCM WAV reader retains source frames and reads bounded stereo windows",async()=>{
 const file=smallWav({frames:4});
 const source=await openWavChunkSource(file);
 assert.equal(source.info.frames,4);
 assert.equal(source.info.channels,2);
 const chunks=[];
 for await(const part of source.iterateFrames({chunkFrames:2}))chunks.push(part);
 assert.equal(chunks.length,2);
 assert.equal(chunks[1].start,2);
 assert.equal(chunks[1].channels[0][0],0.25);
 assert.equal(chunks[1].channels[1][1],-0.5);
 assert.deepEqual((await source.readFrames(1,2))[0],new Float32Array([0.25,0.25]));
});
test("float32 and signed 24-bit sample coding and 4ch source topology",async()=>{
 for(const config of [{bits:32,format:3,channels:4},{bits:24,format:1,channels:4}]){
   const source=await openWavChunkSource(smallWav(config));
   const channels=await source.readFrames(0,4);
   assert.equal(source.info.channels,4);
   assert.equal(channels[0][0],0.25);
   assert.equal(channels[1][0],-0.5);
   const plan=planBufferedPreview(source.info,{memory:{bytes:1e9,basis:"test"}});
   assert.equal(plan.status,"unavailable");
   assert.deepEqual(plan.reasonCodes,["CHANNEL_TOPOLOGY_UNAVAILABLE"]);
   assert.equal(plan.requested.channels,4);
 }
});
test("120MB 625-second PCM WAV is inspected and seek-read without whole-file reads",async()=>{
 const size=120_000_000,header=smallWav({frames:0}).slice(0,44);
 const head=new Uint8Array(await header.arrayBuffer()),dv=new DataView(head.buffer);
 dv.setUint32(4,size-8,true);dv.setUint32(40,size-44,true);
 let peak=0,reads=0;
 const virtual={
   size,
   slice(start,end){
     const length=end-start;
     peak=Math.max(peak,length);reads++;
     const bytes=new Uint8Array(length);
     for(let i=0;i<length;i++)if(start+i<44)bytes[i]=head[start+i];
     return new Blob([bytes]);
   }
 };
 const source=await openWavChunkSource(virtual);
 assert.equal(source.info.encodedBytes,size);
 assert.ok(source.info.durationSeconds>600);
 const tail=await source.readFrames(source.info.frames-2,2);
 assert.equal(tail.length,2);
 assert.equal(tail[1][1],0);
 assert.ok(peak<=8192*4,"large source must only be sliced in bounded windows");
 assert.ok(reads>=3);
 const plan=planBufferedPreview(source.info,{memory:{bytes:1e10,basis:"test"}});
 assert.equal(plan.status,"supported");
 assert.equal(plan.requested.frames,source.info.frames);
 assert.equal(plan.effective.frames,source.info.frames);
});
test("capability planner never truncates duration, preserves requested source on failure",()=>{
 const request={channels:2,frames:48_000*720,sampleRate:48_000};
 const input=Object.freeze({...request});
 const plan=planBufferedPreview(input,{memory:{bytes:100*MIB(),basis:"test"}});
 assert.equal(plan.status,"unavailable");
 assert.equal(plan.requested.frames,48_000*720);
 assert.equal(plan.effective,null);
 assert.deepEqual(input,request);
 assert.deepEqual(plan.reasonCodes,["INSUFFICIENT_BUFFER_MEMORY"]);
 assert.equal(availableAudioMemory({heapLimitBytes:1e9,heapUsedBytes:2e8}).bytes,4e8);
 assert.equal(planCompressedPredecode(50_000_000,{memory:{bytes:80_000_000}}).status,"unavailable");
});
test("RF64 source is explicitly unsupported instead of mislabeled truncated",async()=>{
 const bytes=new Uint8Array(await smallWav({frames:1}).arrayBuffer());
 new DataView(bytes.buffer).setUint32(4,0xffffffff,true);
 await assert.rejects(openWavChunkSource(new Blob([bytes])),error=>error.code==="UNSUPPORTED_RF64");
});
test("unknown browser memory keeps buffered paths conditional without claiming a budget check",()=>{
 const memory={bytes:null,basis:"unknown"};
 const wavPlan=planBufferedPreview({channels:2,frames:48_000*30,sampleRate:48_000},{memory});
 assert.equal(wavPlan.status,"supported");
 assert.equal(wavPlan.estimates.budgetBytes,null);
 const compressedPlan=planCompressedPredecode(50_000_000,{memory});
 assert.equal(compressedPlan.status,"conditional");
 assert.deepEqual(compressedPlan.reasonCodes,["MEMORY_UNVERIFIED"]);
});
function MIB(){return 1024*1024;}
test("malformed WAV, out-of-range reads and aborted read fail without narrowing requested data",async()=>{
 await assert.rejects(openWavChunkSource(new Blob([new Uint8Array(44)])),e=>e.code==="NOT_WAV");
 const source=await openWavChunkSource(smallWav({frames:5}));
 await assert.rejects(source.readFrames(4,2),e=>e.code==="INVALID_RANGE");
 await assert.rejects(source.readFrames(0,8193),e=>e.code==="INVALID_RANGE"||e.code==="CHUNK_TOO_LARGE");
 const controller=new AbortController();controller.abort();
 await assert.rejects(source.readFrames(0,1,{signal:controller.signal}),e=>e.code==="ABORTED");
});
