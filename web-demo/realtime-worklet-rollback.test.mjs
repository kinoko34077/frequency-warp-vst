import {test} from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {runInNewContext} from "node:vm";

// Executes the production AudioWorklet class with a controllable setter ABI.
// It is a deterministic fault injection, not evidence of an actual Rust failure.
async function fixture(){
  const source=await readFile(new URL("./realtime.worklet.js",import.meta.url),"utf8");
  let Processor;
  const messages=[],state={};
  let rejectBits=null,failEveryCrusher=false,freed=0;
  class AudioWorkletProcessor{
    constructor(){this.port={onmessage:null,postMessage:m=>messages.push(m)};}
  }
  runInNewContext(source,{
    AudioWorkletProcessor,
    registerProcessor:(_,klass)=>{Processor=klass;},
    Float32Array,Math,Number,sampleRate:48000,
    performance:{now:()=>0}
  });
  const processor=new Processor();
  const base={
    low:20,high:16000,curvature:1,invert:0,mode:"reciprocal",
    qualityIndex:0,outside:"pass",engine:1,pitchRatio:1,shiftHz:0,
    carrierHz:350,zeroMode:0,axisShift:0,axisReference:350,
    ringEnabled:false,rationalEnabled:false,axisPivot:350,axisSlope:1,
    aMinHz:20,aReverb:0,aBandBins:1,aQuality:0,
    zeroReflectGain:1,zeroReflectDecay:0,crusherBits:0,crusherHold:1
  };
  processor.stream=7;processor.channels=1;
  processor.src=0;processor.dst=0;
  processor.exports={
    warp_stream_set_ext:(_,low,high,curvature,invert,mode,qualityIndex,outside,
      engine,pitchRatio,shiftHz,carrierHz,zeroMode)=>{
      Object.assign(state,{low,high,curvature,invert,mode,qualityIndex,outside,
        engine,pitchRatio,shiftHz,carrierHz,zeroMode});return 0;
    },
    warp_stream_set_transform:(_,axisShift,axisReference,ringEnabled,rationalEnabled)=>{
      Object.assign(state,{axisShift,axisReference,ringEnabled,rationalEnabled});return 0;
    },
    warp_stream_set_geometry:(_,axisPivot,axisSlope)=>{
      Object.assign(state,{axisPivot,axisSlope});return 0;
    },
    warp_stream_set_a_options:(_,aMinHz,aReverb)=>{
      Object.assign(state,{aMinHz,aReverb});return 0;
    },
    warp_stream_set_a_band:(_,aBandBins)=>{state.aBandBins=aBandBins;return 0;},
    warp_stream_set_a_quality:(_,aQuality)=>{state.aQuality=aQuality;return 0;},
    warp_stream_set_zero_reflect_gain:(_,zeroReflectGain)=>{
      state.zeroReflectGain=zeroReflectGain;return 0;
    },
    warp_stream_set_zero_reflect_decay:(_,zeroReflectDecay)=>{
      state.zeroReflectDecay=zeroReflectDecay;return 0;
    },
    warp_stream_set_crusher:(_,crusherBits,crusherHold)=>{
      if(failEveryCrusher||crusherBits===rejectBits)return -2;
      Object.assign(state,{crusherBits,crusherHold});return 0;
    },
    warp_stream_free:()=>{freed++;},
    warp_free_f32:()=>{}
  };
  assert.equal(processor.applySettings(base),0);
  processor.lastGoodSettings={...base};
  return {processor,messages,state,base,
    failOnBits:n=>{rejectBits=n;},failAll:()=>{failEveryCrusher=true;},
    freed:()=>freed};
}
test("successful complete application acknowledges and advances last-good snapshot",async()=>{
  const f=await fixture();
  const next={...f.base,axisPivot:900,aReverb:.4,crusherBits:8};
  f.processor.command({type:"params",settings:next,activeQualityIndex:0,revision:1});
  assert.equal(f.messages.at(-1).type,"parameters-applied");
  assert.equal(f.messages.at(-1).revision,1);
  assert.equal(f.processor.lastGoodSettings.axisPivot,900);
  assert.equal(f.state.aReverb,.4);
});
test("late setter failure restores previous numeric values instead of partial update",async()=>{
  const f=await fixture();
  f.failOnBits(9);
  f.processor.command({type:"params",settings:{
    ...f.base,axisPivot:840,aReverb:.7,zeroReflectGain:.3,crusherBits:9
  },activeQualityIndex:0,revision:2});
  assert.equal(f.messages.length,1);
  assert.equal(f.messages[0].type,"error");
  assert.equal(f.messages[0].revision,2);
  assert.equal(f.messages[0].recovered,true);
  assert.notEqual(f.messages[0].fatal,true);
  assert.equal(f.state.axisPivot,f.base.axisPivot);
  assert.equal(f.state.aReverb,f.base.aReverb);
  assert.equal(f.state.zeroReflectGain,f.base.zeroReflectGain);
  assert.equal(f.state.crusherBits,f.base.crusherBits);
  assert.equal(f.processor.stream,7);
  assert.equal(f.processor.lastGoodSettings.axisPivot,f.base.axisPivot);
});
test("failed rollback frees the partial stream and emits fatal recovery request",async()=>{
  const f=await fixture();
  f.failAll();
  f.processor.command({type:"params",settings:{
    ...f.base,axisPivot:900,aReverb:.6,crusherBits:8
  },activeQualityIndex:0,revision:3});
  assert.equal(f.messages.length,1);
  assert.equal(f.messages[0].type,"error");
  assert.equal(f.messages[0].fatal,true);
  assert.equal(f.processor.stream,0);
  assert.equal(f.processor.lastGoodSettings,null);
  assert.equal(f.freed(),1);
});

test("repeated 128-frame Rust process failure emits ONE fatal and quarantines the stream",async()=>{
  const f=await fixture();
  let processingCalls=0;
  f.processor.exports.warp_stream_process=()=>{processingCalls++;return -2;};
  f.processor.inputView=new Float32Array(128);
  f.processor.outputView=new Float32Array(128);
  f.processor.delay=[new Float32Array(256)];
  const run=()=>f.processor.process([[new Float32Array(128).fill(.25)]],
    [[new Float32Array(128)],[new Float32Array(128)]]);
  for(let i=0;i<25;i++)assert.equal(run(),true);
  assert.equal(processingCalls,1,
    "a native processing failure must not retry unsafe Rust on every audio quantum");
  assert.equal(f.messages.length,1,
    "do not emit hundreds of fatal messages per second");
  assert.equal(f.messages[0].type,"error");
  assert.equal(f.messages[0].fatal,true);
  assert.match(f.messages[0].message,/Streaming core returned -2/);
  assert.equal(f.processor.streamFailed,true);
  // A late control packet cannot revive the quarantined stream.
  f.processor.command({type:"params",settings:{...f.base,axisPivot:900},
    activeQualityIndex:0,revision:10});
  assert.equal(f.state.axisPivot,f.base.axisPivot);
  assert.equal(f.messages.length,1);
  f.processor.command({type:"dispose"});
  assert.equal(f.freed(),1,"release occurs on control callback, not audio quantum");
  assert.equal(f.processor.stream,0);
  assert.equal(f.processor.streamFailed,false);
});
