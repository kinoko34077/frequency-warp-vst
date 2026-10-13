import {test} from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";

async function load() {
  const binary=await readFile("web-demo/dsp_core.wasm");
  const {instance}=await WebAssembly.instantiate(binary,{});
  return instance.exports;
}
test("shared Rust WASM mapping matches accepted curvature and reflection",async ()=>{
  const e=await load();
  for(const p of [0,0.01,.5,1]){
    for(const f of [20,100,500,1000,3000]){
      const mapped=e.warp_map_frequency(f,20,3000,p,1,0);
      assert.ok(Number.isFinite(mapped));
      assert.ok(Math.abs(e.warp_map_frequency(mapped,20,3000,p,1,0)-f)<1e-6);
    }
  }
  assert.ok(Math.abs(e.warp_map_frequency(500,20,3000,1,1,0)-2520)<1e-8);
});
test("native-shared Rust wasm transforms real audio data without JS spectral DSP",async ()=>{
  const e=await load();
  assert.ok(e.memory && e.warp_alloc_f32 && e.warp_process_f32 && e.warp_free_f32);
  const fs=8192,count=4096;
  const src=e.warp_alloc_f32(count),dst=e.warp_alloc_f32(count);
  assert.ok(src&&dst);
  try {
    const pcm=Float32Array.from({length:count},(_,i)=>.7*Math.cos(Math.PI*2*500*i/fs));
    new Float32Array(e.memory.buffer,src,count).set(pcm);
    const status=e.warp_process_f32(src,dst,count,1,fs,20,3000,1,1,0,0);
    assert.equal(status,0);
    const processed=new Float32Array(e.memory.buffer,dst,count);
    let best=0,bestK=0;
    for(let k=250;k<1650;k++){
      const hz=k*fs/count;
      if(Math.abs(hz-2520)>16 && Math.abs(hz-500)>16)continue;
      let re=0,im=0;
      for(let n=0;n<count;n++){
        const phase=2*Math.PI*k*n/count;
        re+=processed[n]*Math.cos(phase);
        im-=processed[n]*Math.sin(phase);
      }
      const mag=Math.hypot(re,im);
      if(mag>best){best=mag;bestK=k;}
    }
    assert.ok(Math.abs(bestK*fs/count-2520)<6,"incorrect output: "+(bestK*fs/count));
    assert.ok(best>500,"unexpectedly low output amplitude: "+best);
  } finally {
    e.warp_free_f32(src,count);e.warp_free_f32(dst,count);
  }
});

test("shared WASM exposes both folds and outside-band Pass/Kill",async ()=>{
  const e=await load();
  assert.ok(e.warp_process_f32_ex,"WASM extended ABI missing");
  const f=700;
  const foldH=e.warp_map_frequency(f,20,3000,1,.3,0);
  const foldL=e.warp_map_frequency(f,20,3000,1,.3,2);
  assert.ok(Math.abs(foldH-foldL)>50);
  assert.ok(Math.abs(e.warp_map_frequency(f,20,3000,1,1,0)-
    e.warp_map_frequency(f,20,3000,1,1,2))<1e-7);
  const fs=8192,n=4096;
  const a=e.warp_alloc_f32(n),b=e.warp_alloc_f32(n);
  try {
    const source=new Float32Array(e.memory.buffer,a,n);
    for(let i=0;i<n;i++)source[i]=.5*Math.cos(2*Math.PI*3700*i/fs);
    assert.equal(e.warp_process_f32_ex(a,b,n,1,fs,20,3000,1,1,0,0,0),0);
    const kill=new Float32Array(e.memory.buffer,b,n);
    let rmsKill=Math.sqrt(kill.reduce((sum,x)=>sum+x*x,0)/n);
    assert.equal(e.warp_process_f32_ex(a,b,n,1,fs,20,3000,1,1,0,0,1),0);
    const pass=new Float32Array(e.memory.buffer,b,n);
    let rmsPass=Math.sqrt(pass.reduce((sum,x)=>sum+x*x,0)/n);
    assert.ok(rmsKill<.08,"Kill leak "+rmsKill);
    assert.ok(rmsPass>.28,"Pass energy dropped "+rmsPass);
  } finally {
    e.warp_free_f32(a,n);e.warp_free_f32(b,n);
  }
});
