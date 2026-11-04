import test from "node:test";
import assert from "node:assert/strict";
import {openPcmWavSource} from "./pcm-wav-source.mjs";

function textInto(bytes,start,text){
  for(let i=0;i<text.length;i++)bytes[start+i]=text.charCodeAt(i);
}
function chunk(kind,content){
  const out=new Uint8Array(8+content.length+(content.length&1));
  textInto(out,0,kind);
  new DataView(out.buffer).setUint32(4,content.length,true);
  out.set(content,8);
  return out;
}
function riff(chunks){
  const size=12+chunks.reduce((n,c)=>n+c.length,0);
  const result=new Uint8Array(size),view=new DataView(result.buffer);
  textInto(result,0,"RIFF");view.setUint32(4,size-8,true);
  textInto(result,8,"WAVE");
  let offset=12;for(const c of chunks){result.set(c,offset);offset+=c.length;}
  return new Blob([result]);
}
function wav(channels,frames,{rate=48000,format=1,bits=16,junk=false}={}){
  const sampleBytes=bits/8,block=sampleBytes*channels;
  const fmt=new Uint8Array(16),formatView=new DataView(fmt.buffer);
  formatView.setUint16(0,format,true);formatView.setUint16(2,channels,true);
  formatView.setUint32(4,rate,true);
  formatView.setUint32(8,rate*block,true);
  formatView.setUint16(12,block,true);formatView.setUint16(14,bits,true);
  const pcm=new Uint8Array(frames.length*block),view=new DataView(pcm.buffer);
  for(let i=0;i<frames.length;i++)for(let c=0;c<channels;c++){
    const offset=i*block+c*sampleBytes,v=frames[i][c];
    if(format===3)view.setFloat32(offset,v,true);
    else if(bits===8)view.setUint8(offset,Math.round(v*128+128));
    else if(bits===16)view.setInt16(offset,Math.round(v*32767),true);
    else if(bits===24){
      const n=Math.round(v*8388607);
      pcm[offset]=n&255;pcm[offset+1]=(n>>>8)&255;pcm[offset+2]=(n>>>16)&255;
    }else if(bits===64){
      view.setBigInt64(offset,0n,true);
    }else throw Error("test fixture sample width");
  }
  return riff([...(junk?[chunk("JUNK",Uint8Array.of(1,2,3))]:[]),
    chunk("fmt ",fmt),chunk("data",pcm)]);
}
test("PCM WAV: chunk read preserves frames, seek and all three channels",async()=>{
  const file=wav(3,[[1,0,-1],[0.5,-0.5,0],[0.25,0,-0.25]],{junk:true});
  const source=await openPcmWavSource(file);
  assert.equal(source.info.channels,3);
  assert.equal(source.info.frames,3);
  assert.equal(source.info.sampleRate,48000);
  const out=await source.readFrames(1,2);
  assert.equal(out.length,3);
  assert.deepEqual(out.map(c=>c.length),[2,2,2]);
  assert.ok(Math.abs(out[0][0]-0.5)<0.0001);
  assert.ok(Math.abs(out[1][0]+0.5)<0.0001);
  assert.ok(Math.abs(out[2][1]+0.25)<0.0001);
  assert.deepEqual(await source.readFrames(3,0),[new Float32Array(0),new Float32Array(0),new Float32Array(0)]);
});
test("PCM WAV: 24-bit integer and 32-bit float are decoded without full-file conversion",async()=>{
  const pcm=await openPcmWavSource(wav(1,[[0.75],[-0.75]],{bits:24}));
  const a=await pcm.readFrames(0,2);
  assert.ok(Math.abs(a[0][0]-.75)<1e-6&&Math.abs(a[0][1]+.75)<1e-6);
  const floating=await openPcmWavSource(wav(1,[[0.333],[-0.333]],{format:3,bits:32}));
  const f=await floating.readFrames(1,1);
  assert.ok(Math.abs(f[0][0]+.333)<1e-6);
});
test("PCM WAV: original duration beyond 600 sec and size beyond 75 MB remain addressable",async()=>{
  const rate=48000,frames=rate*650,channels=2,blockAlign=channels*2;
  const dataBytes=frames*blockAlign,fileBytes=44+dataBytes;
  const header=new Uint8Array(44),v=new DataView(header.buffer);
  textInto(header,0,"RIFF");v.setUint32(4,fileBytes-8,true);textInto(header,8,"WAVE");
  textInto(header,12,"fmt ");v.setUint32(16,16,true);
  v.setUint16(20,1,true);v.setUint16(22,channels,true);
  v.setUint32(24,rate,true);v.setUint32(28,rate*blockAlign,true);
  v.setUint16(32,blockAlign,true);v.setUint16(34,16,true);
  textInto(header,36,"data");v.setUint32(40,dataBytes,true);
  const requests=[];
  const virtual={
    size:fileBytes,
    slice(start,end){
      const size=end-start;requests.push([start,end]);
      assert.ok(size<=1024,"reader attempted an excessive allocation");
      const out=new Uint8Array(size);
      for(let i=0;i<size;i++)if(start+i<header.length)out[i]=header[start+i];
      return {async arrayBuffer(){return out.buffer;}};
    }
  };
  const source=await openPcmWavSource(virtual);
  assert.ok(source.info.sourceByteLength>75_000_000);
  assert.equal(source.info.durationSeconds,650);
  assert.equal(source.info.frames,frames);
  const final=await source.readFrames(frames-2,2);
  assert.deepEqual(final.map(c=>Array.from(c)),[[0,0],[0,0]]);
  assert.ok(requests.reduce((s,[a,b])=>s+(b-a),0)<200,
    "entire file must never be fetched into memory");
});
test("PCM WAV: reads are bounded and out-of-range reads never clamp silently",async()=>{
  const source=await openPcmWavSource(wav(2,[[0,0],[0,0],[0,0]]),{maxReadBytes:8});
  await assert.rejects(source.readFrames(0,3),error=>
    error instanceof RangeError&&/per-call read budget/.test(error.message));
  await assert.rejects(source.readFrames(2,2),error=>
    error instanceof RangeError&&/source frame range/.test(error.message));
  await assert.rejects(source.readFrames(-1,1),error=>
    error instanceof RangeError&&/frame range/.test(error.message));
  assert.deepEqual((await source.readFrames(1,1)).map(a=>Array.from(a)),[[0],[0]]);
});
test("PCM WAV: invalid format or truncated data is rejected",async()=>{
  await assert.rejects(openPcmWavSource(new Blob([Uint8Array.of(1,2,3)])),/incomplete/);
  const file=wav(2,[[0,0]]);
  const data=new Uint8Array(await file.arrayBuffer());
  new DataView(data.buffer).setUint16(20,7,true);
  await assert.rejects(openPcmWavSource(new Blob([data])),/unsupported encoding/);
  data.set(new Uint8Array(await file.arrayBuffer()));
  new DataView(data.buffer).setUint32(40,1000,true);
  await assert.rejects(openPcmWavSource(new Blob([data])),/truncated RIFF chunk/);

  const partial=new Uint8Array(await file.arrayBuffer());
  new DataView(partial.buffer).setUint32(40,3,true);
  await assert.rejects(openPcmWavSource(new Blob([partial])),/partial PCM frame/);

  const shortFmt=riff([chunk("fmt ",new Uint8Array(12)),
    chunk("JUNK",new Uint8Array(4)),chunk("data",new Uint8Array(0))]);
  await assert.rejects(openPcmWavSource(shortFmt),/short fmt chunk/);

  const truncatedContainer=new Uint8Array(await file.arrayBuffer());
  new DataView(truncatedContainer.buffer).setUint32(4,truncatedContainer.length+10,true);
  await assert.rejects(openPcmWavSource(new Blob([truncatedContainer])),/truncated RIFF container/);

  const rf64=new Uint8Array(await file.arrayBuffer());
  new DataView(rf64.buffer).setUint32(4,0xffffffff,true);
  await assert.rejects(openPcmWavSource(new Blob([rf64])),/RF64 requires a separate decoder/);

  for(const [offset,value,wide] of [[22,0,false],[24,0,true],[34,7,false]]){
    const invalidParameters=new Uint8Array(await file.arrayBuffer());
    const view=new DataView(invalidParameters.buffer);
    if(wide)view.setUint32(offset,value,true);else view.setUint16(offset,value,true);
    await assert.rejects(openPcmWavSource(new Blob([invalidParameters])),/unsupported format parameters/);
  }
  await assert.rejects(openPcmWavSource(wav(1,[[0]],{bits:64})),/unsupported format parameters/);
  const padded8=new Uint8Array(await wav(1,[[0]],{bits:8}).arrayBuffer());
  const unpadded8=padded8.slice(0,-1);
  new DataView(unpadded8.buffer).setUint32(4,unpadded8.length-8,true);
  await assert.rejects(openPcmWavSource(new Blob([unpadded8])),/truncated RIFF chunk/);
  await assert.rejects(openPcmWavSource(new Blob([Uint8Array.of(1,2,3)]),{maxReadBytes:0}),
    /invalid read budget/);
});
test("PCM WAV: canceled reads fail instead of returning stale data",async()=>{
  const controller=new AbortController();
  const source=await openPcmWavSource(wav(1,[[0],[.5]]));
  controller.abort();
  await assert.rejects(source.readFrames(0,0,{signal:controller.signal}),
    error=>error instanceof DOMException&&error.name==="AbortError");
  await assert.rejects(source.readFrames(0,1,{signal:controller.signal}),
    error=>error instanceof DOMException&&error.name==="AbortError");
});

test("PCM WAV compatibility API decodes extensible PCM and preserves its byte budget",async()=>{
  const file=extensiblePcmWav([16384,-16384]);
  const source=await openPcmWavSource(file,{maxReadBytes:2});
  assert.deepEqual(source.info,{
    kind:"pcm-wav",format:1,channels:1,sampleRate:48000,blockAlign:2,
    bitsPerSample:16,sampleBytes:2,sampleFormat:"integer",frames:2,
    durationSeconds:2/48000,byteLength:4,sourceByteLength:file.size
  });
  assert.deepEqual(Array.from((await source.readFrames(0,1))[0]),[0.5]);
  await assert.rejects(source.readFrames(0,2),/per-call read budget/);
});
test("PCM WAV compatibility preserves the legacy first-fmt behavior",async()=>{
  const source=await openPcmWavSource(await duplicateFmtWav());
  assert.equal(source.info.channels,1);
  assert.deepEqual(Array.from((await source.readFrames(0,1))[0]),[0.5]);
});

async function duplicateFmtWav(){
  const original=new Uint8Array(await wav(1,[[0.5]]).arrayBuffer());
  const firstFmt=original.slice(12,36),conflictingFmt=firstFmt.slice(),data=original.slice(36);
  const view=new DataView(conflictingFmt.buffer);
  view.setUint16(10,2,true);view.setUint32(12,96000,true);
  view.setUint32(16,192000,true);view.setUint16(20,4,true);
  return riff([firstFmt,conflictingFmt,data]);
}

function extensiblePcmWav(samples){
  const dataBytes=samples.length*2,total=12+8+40+8+dataBytes;
  const bytes=new Uint8Array(total),view=new DataView(bytes.buffer);
  const tag=(at,value)=>{for(let i=0;i<4;i++)bytes[at+i]=value.charCodeAt(i);};
  tag(0,"RIFF");view.setUint32(4,total-8,true);tag(8,"WAVE");
  tag(12,"fmt ");view.setUint32(16,40,true);
  view.setUint16(20,0xfffe,true);view.setUint16(22,1,true);
  view.setUint32(24,48000,true);view.setUint32(28,96000,true);
  view.setUint16(32,2,true);view.setUint16(34,16,true);
  view.setUint16(36,22,true);view.setUint16(38,16,true);view.setUint32(40,4,true);
  view.setUint32(44,1,true);
  bytes.set([0,0,16,0,128,0,0,170,0,56,155,113],48);
  tag(60,"data");view.setUint32(64,dataBytes,true);
  samples.forEach((sample,i)=>view.setInt16(68+i*2,sample,true));
  return new Blob([bytes],{type:"audio/wav"});
}
