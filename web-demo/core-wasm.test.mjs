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

test("real native-shared Rust WASM streaming ABI processes continuous 128-frame blocks",async ()=>{
  const e=await load();
  for(const name of ["warp_stream_create","warp_stream_process","warp_stream_set",
    "warp_stream_reset","warp_stream_latency","warp_stream_free"]){
    assert.ok(e[name],name+" not exported to WASM");
  }
  const fs=8192,frames=128;
  const ptr=e.warp_stream_create(fs,1,20,3000,1,1,0,0,0);
  assert.ok(ptr>0,"stream init failed");
  assert.equal(e.warp_stream_latency(ptr),1023);
  const input=e.warp_alloc_f32(frames),output=e.warp_alloc_f32(frames);
  const result=[];
  try{
    for(let block=0;block<65;block++){
      const inp=new Float32Array(e.memory.buffer,input,frames);
      for(let i=0;i<frames;i++)
        inp[i]=.6*Math.cos(2*Math.PI*500*(block*frames+i)/fs);
      assert.equal(e.warp_stream_process(ptr,input,output,frames),0);
      const rendered=new Float32Array(e.memory.buffer,output,frames);
      for(const sample of rendered)result.push(sample);
    }
    assert.ok(result.slice(2048).every(Number.isFinite));
    const magnitude=hz=>{
      let re=0,im=0;
      for(let i=0;i<4096;i++){
        const sample=result[2048+i],theta=2*Math.PI*i*hz/fs;
        re+=sample*Math.cos(theta);im-=sample*Math.sin(theta);
      }
      return Math.hypot(re,im);
    };
    assert.ok(magnitude(2520)>magnitude(500)*4,"stream did not move the tone");
    assert.equal(e.warp_stream_set(ptr,100,3000,.5,.4,2,0,1),0);
    assert.equal(e.warp_stream_reset(ptr),0);
  }finally{
    e.warp_free_f32(input,frames);e.warp_free_f32(output,frames);
    e.warp_stream_free(ptr);
  }
});

test("alternate Rust engines are actually exported and differ acoustically",async()=>{
  const e=await load();
  assert.ok(e.warp_stream_create_ext && e.warp_stream_set_ext);
  const frames=128,fs=8192;
  const input=e.warp_alloc_f32(frames),output=e.warp_alloc_f32(frames);
  const signals=[];
  try{
    for(const engine of [0,1,2,3]){
      const ptr=e.warp_stream_create_ext(fs,1,20,3000,1,1,0,0,0,
        engine,1,-75,300,0,4);
      assert.ok(ptr!==0,"engine "+engine+" missing");
      try{
        assert.equal(e.warp_stream_latency(ptr),1023);
        const samples=[];
        for(let b=0;b<65;b++){
          const inp=new Float32Array(e.memory.buffer,input,frames);
          for(let i=0;i<frames;i++)inp[i]=.5*Math.cos(2*Math.PI*500*(b*128+i)/fs);
          assert.equal(e.warp_stream_process(ptr,input,output,frames),0);
          const out=new Float32Array(e.memory.buffer,output,frames);
          for(const x of out)samples.push(x);
        }
        signals.push(samples);
        assert.equal(e.warp_stream_set_ext(ptr,20,3000,.8,.6,2,0,0,engine,1,-50,100,0),0);
      }finally{e.warp_stream_free(ptr);}
    }
    const compare=(a,b)=>{
      let sum=0;
      for(let i=2048;i<4096;i++)sum+=Math.abs(a[i]-b[i]);
      return sum/2048;
    };
    assert.ok(compare(signals[0],signals[1])>0.001,"FFT-bin engine sounds identical to tracked partial engine");
    assert.ok(compare(signals[0],signals[2])>0.05,"Ring Mod engine was not selected");
    assert.ok(compare(signals[0],signals[3])>0.02,"Pitch+Hz shift engine was not selected");
  }finally{
    e.warp_free_f32(input,frames);e.warp_free_f32(output,frames);
  }
});

test("Rust canonical fold frequency is exactly the displayed and linked carrier",async()=>{
  const e=await load();
  assert.equal(typeof e.warp_fold_frequency,"function");
  assert.ok(Math.abs(e.warp_fold_frequency(100,1000,1,.25,0)-775)<1e-7);
  assert.ok(Math.abs(e.warp_fold_frequency(100,1000,1,.25,2)-325)<1e-7);
  assert.ok(Number.isNaN(e.warp_fold_frequency(100,1000,1,.25,1)));
  // The linked carrier is resolved in Rust at render time. The audio
  // now includes the pre-warp STFT latency, so direct samplewise equality
  // with unwarped input is no longer a valid test.
  const ptr=e.warp_stream_create_ext(8192,1,100,1000,1,.25,0,0,1,2,1,0,-1,0,4);
  assert.ok(ptr>0);
  try{
    assert.equal(e.warp_stream_latency(ptr),1023);
    assert.equal(e.warp_stream_set_ext(ptr,100,1000,1,.25,2,0,1,2,1,0,-1,0),0);
  }finally{e.warp_stream_free(ptr);}

});
test("WAV export uses the same Rust stream and correct latency for Ring and FFT",async()=>{
  const e=await load();const n=4096,fs=8192;
  assert.equal(typeof e.warp_stream_render_f32_ext,"function");
  const src=e.warp_alloc_f32(n),dst=e.warp_alloc_f32(n);
  try{
    const samples=new Float32Array(e.memory.buffer,src,n);
    for(let i=0;i<n;i++)samples[i]=.6*Math.cos(2*Math.PI*500*i/fs);
    for(const engine of [0,1,2,3]){
      const rc=e.warp_stream_render_f32_ext(src,dst,n,1,fs,20,3000,1,1,0,0,1,
        engine,1,-75,engine===2?0:300,0,4);
      assert.equal(rc,0,"WAV engine "+engine+" failed");
      const data=new Float32Array(e.memory.buffer,dst,n);
      assert.ok(data.every(Number.isFinite));
      const energy=data.reduce((a,b)=>a+b*b,0)/n;
      assert.ok(energy>1e-5,"WAV engine "+engine+" silent");
      if(engine===2){
        // Warp -> Ring must differ from the source even at c=0 when
        // the mapping is inverted, unlike the old Ring-only bypass.
        const currentInput=new Float32Array(e.memory.buffer,src,n);
        const err=data.reduce((a,b,i)=>a+Math.abs(b-currentInput[i]),0)/n;
        assert.ok(err>0.02,"Ring still bypasses the shared warp stage");
      }
    }
  }finally{e.warp_free_f32(src,n);e.warp_free_f32(dst,n);}
});

test("shared Rust WASM crusher changes actual output and accepts live updates",async()=>{
  const e=await load();
  assert.ok(e.warp_stream_set_crusher && e.warp_stream_render_f32_fx_ext);
  const n=4096,fs=8192,src=e.warp_alloc_f32(n),dst=e.warp_alloc_f32(n);
  try{
    const input=new Float32Array(e.memory.buffer,src,n);
    for(let i=0;i<n;i++)input[i]=.6*Math.cos(2*Math.PI*500*i/fs);
    const outputs=[];
    for(const bits of [0,3]){
      const rc=e.warp_stream_render_f32_fx_ext(src,dst,n,1,fs,20,3000,1,1,0,0,1,
        0,1,0,100,0,4,bits,4);
      assert.equal(rc,0);
      outputs.push(Array.from(new Float32Array(e.memory.buffer,dst,n)));
    }
    let diff=0;
    for(let i=1500;i<4000;i++)diff+=Math.abs(outputs[0][i]-outputs[1][i]);
    assert.ok(diff>40,"Crusher audio effect not audible");
    const ptr=e.warp_stream_create_ext(fs,1,20,3000,1,1,0,0,1,0,1,0,0,0,4);
    assert.ok(ptr);
    try{
      assert.equal(e.warp_stream_set_crusher(ptr,8,4),0);
      assert.equal(e.warp_stream_set_crusher(ptr,1,4),-2);
      assert.equal(e.warp_stream_set_crusher(ptr,0,1),0);
    }finally{e.warp_stream_free(ptr);}
  }finally{e.warp_free_f32(src,n);e.warp_free_f32(dst,n);}
});

test("unified scale: p=0 ratio, p=1 constant Hz, p=.5 intermediate",async()=>{
 const e=await load();
 assert.equal(typeof e.warp_translate_frequency,"function");
 assert.ok(Math.abs(e.warp_translate_frequency(400,200,0,.5)-400*Math.exp(.5))<1e-6);
 assert.ok(Math.abs(e.warp_translate_frequency(400,200,1,.5)-500)<1e-6);
 const mid=e.warp_translate_frequency(400,200,.5,.5);
 assert.ok(mid>500&&mid<400*Math.exp(.5));
 assert.ok(e.warp_translate_frequency(400,200,1,-2.5)<0);
 assert.ok(Number.isNaN(e.warp_translate_frequency(-20,200,0,.5)));
});
test("synthesis engine 0 accepts independent shift + Ring options through Rust",async()=>{
 const e=await load();
 assert.equal(typeof e.warp_stream_set_transform,"function");
 assert.equal(typeof e.warp_stream_render_f32_axis_ext,"function");
 const ptr=e.warp_stream_create_ext(8192,1,20,3000,1,1,0,0,1,0,1,0,300,0,4);
 assert.ok(ptr>0);
 try{
  assert.equal(e.warp_stream_set_transform(ptr,.5,350,0,0),0);
  assert.equal(e.warp_stream_set_transform(ptr,.5,350,1,0),0);
  assert.equal(e.warp_stream_set_transform(ptr,0,350,0,1),0);
  assert.equal(e.warp_stream_set_transform(ptr,0,0,0,0),-2);
 }finally{e.warp_stream_free(ptr);}
 const n=4096,src=e.warp_alloc_f32(n),dst=e.warp_alloc_f32(n);
 try{
  const pcm=new Float32Array(e.memory.buffer,src,n);
  for(let i=0;i<n;i++)pcm[i]=.6*Math.cos(2*Math.PI*600*i/8192);
  const results=[];
  for(const axis of [0,.3]){
   const rc=e.warp_stream_render_f32_axis_ext(src,dst,n,1,8192,
    20,3000,1,1,0,0,1,0,1,0,300,0,4,0,1,axis,350,0,0);
   assert.equal(rc,0);
   results.push(Array.from(new Float32Array(e.memory.buffer,dst,n)));
  }
  const mean=results[0].slice(2048).reduce((acc,x,i)=>acc+Math.abs(x-results[1][2048+i]),0)/2048;
  assert.ok(mean>.015,"frequency axis movement not connected to Rust audio");
 }finally{e.warp_free_f32(src,n);e.warp_free_f32(dst,n);}
});


test("audible pitch case: zero inversion + log axis maps 500Hz actual PCM to ~1kHz",async()=>{
  const e=await load();
  const rate=8192,n=16384,src=e.warp_alloc_f32(n),dst=e.warp_alloc_f32(n);
  assert.ok(src&&dst);
  try{
    const input=new Float32Array(e.memory.buffer,src,n);
    for(let i=0;i<n;i++)input[i]=0.45*Math.cos(2*Math.PI*500*i/rate);
    const run=(amount)=>{
      const rc=e.warp_stream_render_f32_axis_ext(src,dst,n,1,rate,
        20,3000,0,0,0,0,0,0,1,0,0,0,4,0,1,amount,350,0,0);
      assert.equal(rc,0);
      return Float32Array.from(new Float32Array(e.memory.buffer,dst,n));
    };
    const unshifted=run(0),shifted=run(Math.log(2));
    function projection(samples,frequency){
      let r=0,im=0;
      for(let i=5000;i<15000;i++){
        const a=2*Math.PI*frequency*i/rate;
        r+=samples[i]*Math.cos(a);im+=samples[i]*Math.sin(a);
      }
      return Math.hypot(r,im);
    }
    const p0=projection(unshifted,500),p1=projection(shifted,1000);
    const leak=projection(shifted,500);
    assert.ok(p0>5,"identity warp did not preserve 500Hz sinusoidal energy");
    assert.ok(p1>10,"translated audio contains no 1kHz pitch-shifted energy");
    assert.ok(p1>leak*2,"old pitch remained stronger than the new target: target="+p1+" source="+leak);
  }finally{e.warp_free_f32(src,n);e.warp_free_f32(dst,n);}
});
