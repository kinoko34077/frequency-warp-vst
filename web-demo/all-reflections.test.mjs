import {test} from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
test("actual Rust/WASM folded output above 0Hz obeys C and reflection R",async()=>{
 const binary=await readFile("web-demo/dsp_core.wasm");
 const e=(await WebAssembly.instantiate(binary,{})).instance.exports;
 const n=8192,fs=8192,src=e.warp_alloc_f32(n),dst=e.warp_alloc_f32(n);
 try{
  const run=(f,C,R)=>{
   const input=new Float32Array(e.memory.buffer,src,n);
   for(let i=0;i<n;i++)input[i]=.42*Math.cos(2*Math.PI*f*i/fs);
   const args=[src,dst,n,1,fs,100,1000,1,.5,0,0,0,1,1,0,0,0,4,
     0,1,0,350,0,0,350,1,20,0,1,0,C,R];
   assert.equal(e.warp_stream_render_f32_zero_controls_ext(...args),0);
   const output=new Float32Array(e.memory.buffer,dst,n);
   let sum=0;for(let i=2400;i<n;i++)sum+=output[i]**2;
   return Math.sqrt(sum/(n-2400));
  };
  const baseline=run(800,1,0),half=run(800,.5,0);
  const reflectedOff=run(800,0,0),forward=run(300,0,0);
  console.log("POSITIVE_FOLD_AUDIO "+JSON.stringify({baseline,half,reflectedOff,forward}));
  assert.ok(baseline>.1);
  assert.ok(Math.abs(half/baseline-.5)<.03);
  assert.ok(reflectedOff<baseline*.03);
  assert.ok(forward>.1);
 }finally{e.warp_free_f32(src,n);e.warp_free_f32(dst,n);}
});
