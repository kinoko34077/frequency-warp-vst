import {test} from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {runInNewContext} from "node:vm";

// Real AudioWorklet processor code, with a deterministic copying DSP ABI
// fixture. This tests meter time semantics, not Rust sound quality.
async function meterFixture(){
  const source=await readFile(new URL("./realtime.worklet.js",import.meta.url),"utf8");
  let Processor;
  const messages=[];
  class AudioWorkletProcessor {
    constructor(){this.port={onmessage:null,postMessage:m=>messages.push(m)};}
  }
  runInNewContext(source,{
    AudioWorkletProcessor,
    registerProcessor:(name,klass)=>{
      assert.equal(name,"frequency-warp-rust");Processor=klass;
    },
    sampleRate:48000,Float32Array,Math,Number,
    performance:{now:()=>0}
  });
  const p=new Processor();
  p.stream=1;p.channels=1;p.latency=0;
  p.delay=[new Float32Array(256)];
  p.inputView=new Float32Array(128);
  p.outputView=new Float32Array(128);
  p.src=1;p.dst=2;
  p.exports={
    warp_stream_process:()=>{
      p.outputView.set(p.inputView);
      return 0;
    },
    warp_stream_reset:()=>0
  };
  const block=level=>{
    p.process([[new Float32Array(128).fill(level)]],
      [[new Float32Array(128)],[new Float32Array(128)]]);
  };
  return {p,messages,block};
}

test("RMS reports the latest 160-block interval, not a session average",async()=>{
  const {messages,block}=await meterFixture();
  for(let i=0;i<160;i++)block(.5);
  assert.equal(messages.length,1);
  assert.equal(messages[0].inputRms,.5);
  assert.equal(messages[0].outputRms,.5);
  assert.ok(Math.abs(messages[0].windowSeconds-160*128/48000)<1e-12);
  for(let i=0;i<160;i++)block(0);
  assert.equal(messages.length,2);
  assert.equal(messages[1].inputRms,0);
  assert.equal(messages[1].outputRms,0);
  assert.ok(messages[1].sessionInputRms>.3,
    "lifetime average deliberately retains earlier loud input");
  assert.equal(messages[1].blocks,320,"CPU block counter stays cumulative");
});
test("reset/seek flushes recent RMS, not the global diagnostic clocks",async()=>{
  const {p,messages,block}=await meterFixture();
  for(let i=0;i<80;i++)block(.75);
  p.command({type:"reset"});
  for(let i=0;i<80;i++)block(0);
  assert.equal(messages.length,1);
  assert.equal(messages[0].inputRms,0);
  assert.equal(messages[0].outputRms,0);
  assert.equal(messages[0].blocks,160);
  assert.ok(Math.abs(messages[0].windowSeconds-80*128/48000)<1e-12);
});
