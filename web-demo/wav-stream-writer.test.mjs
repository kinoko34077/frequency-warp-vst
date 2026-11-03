import test from "node:test";
import assert from "node:assert/strict";
import {pcm16WavHeader,encodePcm16Wav,writePcm16WavToSink} from "./wav-stream-writer.mjs";

test("RIFF header and streamed PCM16 interleaving preserve samples",async()=>{
 const writes=[],reads=[];
 const source=(start,count)=>{reads.push({start,count});return [
   Float32Array.from({length:count},()=>.5),
   Float32Array.from({length:count},()=>-.25)
 ];};
 for await(const bytes of encodePcm16Wav({
    frames:5,channels:2,sampleRate:48000,readFrames:source,chunkFrames:2
 }))writes.push(bytes);
 assert.equal(writes.length,4);
 assert.deepEqual(reads,[{start:0,count:2},{start:2,count:2},{start:4,count:1}]);
 const head=new DataView(writes[0].buffer);
 assert.equal(new TextDecoder().decode(writes[0].slice(0,4)),"RIFF");
 assert.equal(head.getUint32(4,true),36+20);
 assert.equal(head.getUint32(40,true),20);
 const first=new DataView(writes[1].buffer);
 assert.equal(first.getInt16(0,true),16384);
 assert.equal(first.getInt16(2,true),-8192);
 assert.ok(writes.slice(1).every(x=>x.byteLength<=2*2*2));
});
test("RF64 metadata represents >4GiB outputs without allocating the payload",()=>{
 const frames=3_000_000_000;
 const bytes=pcm16WavHeader({frames,channels:2,sampleRate:48000});
 const view=new DataView(bytes.buffer);
 assert.equal(bytes.byteLength,80);
 assert.equal(new TextDecoder().decode(bytes.slice(0,4)),"RF64");
 assert.equal(view.getBigUint64(20,true),BigInt(frames)*4n+72n);
 assert.equal(view.getBigUint64(28,true),BigInt(frames)*4n);
 assert.equal(view.getBigUint64(36,true),BigInt(frames));
 assert.equal(view.getUint32(76,true),0xFFFFFFFF);
});
test("backpressure sink writes bounded parts and closes once",async()=>{
 const parts=[];let closed=0;
 const sink={async write(b){parts.push(b.byteLength);},async close(){closed++;}};
 await writePcm16WavToSink({
    sink,frames:20000,channels:1,sampleRate:44100,chunkFrames:4096,
    readFrames:async(_at,count)=>[new Float32Array(count)]
 });
 assert.equal(closed,1);
 assert.equal(parts[0],44);
 assert.equal(parts.length,6);
 assert.ok(Math.max(...parts)<=8192);
});
test("reader error propagates, aborts sink, and never claims completed file",async()=>{
 let closed=0,aborted=0;
 const sink={write:async()=>{},close:()=>{closed++;},abort:()=>{aborted++;}};
 await assert.rejects(writePcm16WavToSink({
    sink,frames:8,channels:2,sampleRate:48000,chunkFrames:4,
    readFrames:async(start,count)=>start===0?
      [new Float32Array(count),new Float32Array(count)]:
      [new Float32Array(count)]
 }),/チャンネル数が不整合/);
 assert.equal(closed,0);assert.equal(aborted,1);
});
test("invalid input fails before exporting fake metadata",()=>{
 assert.throws(()=>pcm16WavHeader({frames:Infinity,channels:2,sampleRate:48000}));
 assert.throws(()=>pcm16WavHeader({frames:1,channels:40000,sampleRate:48000}));
});
