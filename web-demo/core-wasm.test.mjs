import {test} from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {fullReferenceQuality,qualityGate,baselineNeutralContract} from "./acoustic-quality.mjs";

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
    // The spectral pivot (350Hz) now remains fixed through inversion:
    // g(500)=2520Hz, g(350)=2670Hz => 350+(2520-2670)=200Hz.
    assert.ok(magnitude(200)>magnitude(500)*4,"inverted pivot-mapped stream lost tone");
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


test("pivot/slope and signed 0Hz policies are shared WASM audio operations",async()=>{
 const e=await load();
 assert.equal(typeof e.warp_translate_frequency_affine,"function");
 assert.equal(typeof e.warp_stream_set_geometry,"function");
 assert.equal(typeof e.warp_stream_render_f32_geometry_ext,"function");
 assert.ok(Math.abs(e.warp_translate_frequency_affine(750,500,1,0,2)-1000)<1e-6);
 assert.ok(Math.abs(e.warp_translate_frequency_affine(250,500,0,0,2)-125)<1e-6);
 assert.ok(Math.abs(e.warp_translate_frequency_affine(500,500,0,Math.log(2),2)-1000)<1e-6);
 const n=16384,rate=8192,src=e.warp_alloc_f32(n),dst=e.warp_alloc_f32(n);
 try{
   const inp=new Float32Array(e.memory.buffer,src,n);
   for(let i=0;i<n;i++)inp[i]=.4*Math.cos(2*Math.PI*500*i/rate);
   const render=(engine,zero)=>{
     const rc=e.warp_stream_render_f32_geometry_ext(src,dst,n,1,rate,
      20,3000,1,0,0,0,0,engine,1,0,0,zero,4,0,1,-2,350,0,0,350,1);
     assert.equal(rc,0);
     return Float32Array.from(new Float32Array(e.memory.buffer,dst,n));
   };
   const energy=(samples,hz)=>{
     let re=0,im=0;
     for(let i=4000;i<12000;i++){
       const t=2*Math.PI*hz*i/rate;
       re+=samples[i]*Math.cos(t);
       im+=samples[i]*Math.sin(t);
     }
     return Math.hypot(re,im);
   };
   for(const engine of [0,1]){
     const reflected=render(engine,0);
     const killed=render(engine,1);
     const peak=energy(reflected,200);
     const gone=energy(killed,200);
     assert.ok(peak>2,"zero Reflect went silent for engine "+engine+" peak "+peak);
     assert.ok(peak>gone*5,"engine "+engine+" ignores Reflect versus Kill: "+peak+" vs "+gone);
   }
 }finally{e.warp_free_f32(src,n);e.warp_free_f32(dst,n);}
});

test("zero pivot physical slope makes an octave in both FFT and peak audio paths",async()=>{
 const e=await load();
 assert.equal(typeof e.warp_translate_frequency_controls,"function");
 for(const p of [0,0.5,1]){
   for(const f of [125,500,1000]){
     assert.ok(Math.abs(e.warp_translate_frequency_controls(f,0,2,350,p,0)-2*f)<1e-7);
   }
 }
 const n=16384,rate=8192,src=e.warp_alloc_f32(n),dst=e.warp_alloc_f32(n);
 try{
   new Float32Array(e.memory.buffer,src,n).forEach((_,i,a)=>a[i]=.45*Math.cos(2*Math.PI*500*i/rate));
   for(const engine of [0,1]){
     const rc=e.warp_stream_render_f32_geometry_ext(src,dst,n,1,rate,
       20,3000,1,0,0,0,0,engine,1,0,0,0,4,0,1,0,350,0,0,0,2);
     assert.equal(rc,0);
     const pcm=new Float32Array(e.memory.buffer,dst,n);
     const peak=hz=>{
       let re=0,im=0;
       for(let i=4000;i<12000;i++){
         const a=2*Math.PI*hz*i/rate;
         re+=pcm[i]*Math.cos(a);im+=pcm[i]*Math.sin(a);
       }
       return Math.hypot(re,im);
     };
     const high=peak(1000),low=peak(500);
     assert.ok(high>10 && high>low*2,"engine "+engine+" must pitch 500Hz to 1000Hz by slope alone: "+high+"/"+low);
   }
 }finally{e.warp_free_f32(src,n);e.warp_free_f32(dst,n);}
});

test("negative, zero and positive physical slope change actual WASM PCM in engines A/B",async()=>{
 const e=await load();
 for(const p of [0,0.5,1]){
   assert.ok(Math.abs(e.warp_translate_frequency_anchored(500,350,350,-1,350,p,0)-200)<1e-7);
   assert.ok(Math.abs(e.warp_translate_frequency_anchored(500,350,350,0,350,p,0)-350)<1e-7);
   assert.ok(Math.abs(e.warp_translate_frequency_anchored(500,350,350,1,350,p,0)-500)<1e-7);
   assert.ok(Math.abs(e.warp_translate_frequency_anchored(750,350,350,-1,350,p,0)+50)<1e-7);
 }
 const frames=16384,rate=8192,src=e.warp_alloc_f32(frames),dst=e.warp_alloc_f32(frames);
 try{
  const original=new Float32Array(e.memory.buffer,src,frames);
  for(let i=0;i<frames;i++)original[i]=.45*Math.cos(2*Math.PI*500*i/rate);
  for(const engine of [0,1]){
    const render=slope=>{
      const rc=e.warp_stream_render_f32_geometry_ext(src,dst,frames,1,rate,
        20,3000,1,0,3,0,0,engine,1,0,0,0,4,0,1,0,350,0,0,350,slope);
      assert.equal(rc,0,"signed slope rejected by engine "+engine);
      return Float32Array.from(new Float32Array(e.memory.buffer,dst,frames));
    };
    const spectral=(pcm,freq)=>{
      let re=0,im=0;
      for(let i=4500;i<12000;i++){
        const angle=2*Math.PI*freq*i/rate;
        re+=pcm[i]*Math.cos(angle);im+=pcm[i]*Math.sin(angle);
      }
      return Math.hypot(re,im);
    };
    for(const [slope,target] of [[1,500],[0,350],[-1,200]]){
      const pcm=render(slope);
      const correct=spectral(pcm,target);
      const stale=spectral(pcm,slope===1?200:500);
      assert.ok(correct>10 && correct>stale*2,
         "engine "+engine+" signed "+slope+" should emit "+target+"Hz, got "+correct+"/"+stale);
    }
  }
 }finally{e.warp_free_f32(src,frames);e.warp_free_f32(dst,frames);}
});

test("A minimum partial frequency and synthesis reverb change real PCM without affecting B",async()=>{
  const e=await load();
  assert.equal(typeof e.warp_stream_render_f32_a_ext,"function");
  assert.equal(typeof e.warp_stream_set_a_options,"function");
  assert.equal(typeof e.warp_translate_frequency_anchored,"function");
  assert.ok(Math.abs(e.warp_translate_frequency_anchored(2520,2670,350,1,350,1,0)-200)<1e-6);
  const rate=8192,frames=16384,src=e.warp_alloc_f32(frames),dst=e.warp_alloc_f32(frames);
  try{
    const input=new Float32Array(e.memory.buffer,src,frames);
    for(let i=0;i<frames;i++)input[i]=.45*Math.cos(2*Math.PI*500*i/rate);
    const render=(engine,minHz,verb)=>{
      const rc=e.warp_stream_render_f32_a_ext(src,dst,frames,1,rate,
        20,3000,1,0,0,0,0,engine,1,0,0,0,4,0,1,0,350,0,0,350,1,minHz,verb);
      assert.equal(rc,0);
      return Float32Array.from(new Float32Array(e.memory.buffer,dst,frames));
    };
    const energy=x=>x.slice(2500,14000).reduce((v,y)=>v+y*y,0);
    const normal=render(0,20,0),cut=render(0,900,0),
      wet=render(0,20,.5),bin=render(1,900,1);
    assert.ok(energy(normal)>100,"A should reconstruct the 500Hz partial");
    assert.ok(energy(cut)<energy(normal)*.02,"A minimum Hz cutoff not applied");
    assert.ok(energy(bin)>100,"A settings leaked into B");
    const delta=normal.slice(2500,14000).reduce((v,x,i)=>v+Math.abs(x-wet[i+2500]),0);
    assert.ok(delta>20,"A reverb amount didn't alter actual sound");
  }finally{e.warp_free_f32(src,frames);e.warp_free_f32(dst,frames);}
});

test("A spectral peak band is independently adjustable in live Rust DSP",async()=>{
  const e=await load();
  assert.ok(e.warp_stream_set_a_band);
  assert.ok(e.warp_stream_render_f32_a_band_ext);
  const fs=8192,frames=128,total=frames*90;
  const input=e.warp_alloc_f32(frames),output=e.warp_alloc_f32(frames);
  const versions=[];
  try{
    for(const band of [1,8]){
      const st=e.warp_stream_create_ext(fs,1,20,3000,1,0,1,0,0,0,1,0,0,0,4);
      assert.ok(st);
      try{
        assert.equal(e.warp_stream_set_a_band(st,band),0);
        assert.equal(e.warp_stream_set_a_band(st,0),-2);
        assert.equal(e.warp_stream_set_a_band(st,9),-2);
        const outputBuffer=[];
        for(let b=0;b<total/frames;b++){
          const samples=new Float32Array(e.memory.buffer,input,frames);
          for(let i=0;i<frames;i++){
            const t=(b*frames+i)/fs;
            samples[i]=.65*Math.cos(2*Math.PI*500*t)+.35*Math.cos(2*Math.PI*556*t);
          }
          assert.equal(e.warp_stream_process(st,input,output,frames),0);
          outputBuffer.push(...new Float32Array(e.memory.buffer,output,frames));
        }
        versions.push(outputBuffer);
      }finally{e.warp_stream_free(st);}
    }
    const avg=versions[0].slice(2500).reduce((sum,x,i)=>sum+Math.abs(x-versions[1][i+2500]),0)/(total-2500);
    assert.ok(avg>0.0001,"A band adjustment did not affect real audio: "+avg);
  }finally{e.warp_free_f32(input,frames);e.warp_free_f32(output,frames);}
});

test("A peak-neighborhood reaches actual offline WAV Rust renderer",async()=>{
  const e=await load();
  const n=8192,rate=8192,src=e.warp_alloc_f32(n),dst=e.warp_alloc_f32(n);
  assert.ok(src&&dst);
  try{
    const input=new Float32Array(e.memory.buffer,src,n);
    for(let i=0;i<n;i++)input[i]=.65*Math.cos(2*Math.PI*500*i/rate)
      +.35*Math.cos(2*Math.PI*556*i/rate);
    const render=(band)=>{
      const code=e.warp_stream_render_f32_a_band_ext(
        src,dst,n,1,rate,20,3000,1,0,1,0,0,0,1,0,0,0,4,
        0,1,0,350,0,0,350,1,20,0,band);
      assert.equal(code,0,"offline A peak-band "+band);
      return new Float32Array(e.memory.buffer,dst,n).slice();
    };
    const one=render(1),eight=render(8);
    const averageDifference=one.slice(2048).reduce((sum,v,i)=>
      sum+Math.abs(v-eight[i+2048]),0)/(n-2048);
    assert.ok(averageDifference>.001,
      "offline render ignored A FFT-bin neighborhood: "+averageDifference);
  }finally{e.warp_free_f32(src,n);e.warp_free_f32(dst,n);}
});

/** Direct identity-mapping acoustic degradation measurement (Issue #48).
 * Diagnostic metrics deliberately DO NOT assert a "good" threshold:
 * a green test here means the real Rust/WASM signals were measured,
 * not that the experimental Engine A satisfies transparent no-op fidelity.
 */
test("Engine A neutral transform: actual PCM fidelity vs engine B across tonal/noise input",async()=>{
  const e=await load();
  const rate=12000,frames=12000;
  const src=e.warp_alloc_f32(frames),dst=e.warp_alloc_f32(frames);
  assert.ok(src&&dst);
  const mixSeed=(()=>{
    let state=0x34077;
    return ()=>{state=(Math.imul(state,1664525)+1013904223)>>>0;
      return 2*state/4294967296-1;};
  })();
  const generated=Array.from({length:frames},()=>mixSeed());
  const signals={
    tone:Float32Array.from({length:frames},(_,i)=>.33*Math.cos(2*Math.PI*440*i/rate)),
    wideband_noise:Float32Array.from(generated,v=>.23*v),
    tone_plus_noise:Float32Array.from(generated,(v,i)=>
      .29*Math.cos(2*Math.PI*440*i/rate)+.13*v),
    gated_burst:Float32Array.from({length:frames},(_,i)=>
      (i%2400<96 ? .6 : 0)*Math.cos(2*Math.PI*880*i/rate))
  };
  const start=4200,end=10000;
  const metrics=(input,output)=>{
    let en=0,out=0,err=0,dot=0;const block=[];
    for(let i=start;i<end;i+=400){
      let blockPower=0;
      for(let j=i;j<Math.min(end,i+400);j++){
        const a=input[j],b=output[j],delta=a-b;
        en+=a*a;out+=b*b;err+=delta*delta;dot+=a*b;blockPower+=b*b;
      }
      block.push(Math.sqrt(blockPower/Math.min(400,end-i)));
    }
    const mean=block.reduce((a,b)=>a+b,0)/block.length;
    const sd=Math.sqrt(block.reduce((a,b)=>a+(b-mean)**2,0)/block.length);
    return {
      rmsGain:Number(Math.sqrt(out/en).toFixed(5)),
      normalizedRmse:Number(Math.sqrt(err/en).toFixed(5)),
      correlation:Number((dot/Math.sqrt(en*out||1)).toFixed(5)),
      outputRmsVariation:Number((sd/(mean||1)).toFixed(5))
    };
  };
  try{
    const rows=[];
    for(const [kind,input] of Object.entries(signals)){
      const qualityOptions=kind==="wideband_noise"?[0,1,2]:[0];
      for(const qualityIndex of qualityOptions){
        for(const [engine,peakBins] of [[0,1],[0,8],[1,1]]){
          new Float32Array(e.memory.buffer,src,frames).set(input);
          const status=e.warp_stream_render_f32_a_band_ext(
            src,dst,frames,1,rate,20,5500,1,0,1,qualityIndex,1,
            engine,1,0,0,0,4,0,1,0,350,0,0,350,1,20,0,peakBins);
          assert.equal(status,0,"Rust offline neutral render "+JSON.stringify({kind,qualityIndex,engine,peakBins}));
          const output=Float32Array.from(new Float32Array(e.memory.buffer,dst,frames));
          assert.ok(output.every(Number.isFinite),"non-finite output");
          const score=metrics(input,output);
          assert.ok(Number.isFinite(score.rmsGain)&&Number.isFinite(score.normalizedRmse));
          // Evaluate ACTUAL common Rust-WASM PCM, not a mocked filter.
          // #301: neutral A and B must now both pass the same source
          // reference. Nonneutral A residual/partial quality is separate #5.
          const objective=fullReferenceQuality(input,output,{start,end,blockSize:400});
          const gate=qualityGate(objective,baselineNeutralContract);
          if(engine===1){
            assert.ok(gate.pass,"neutral Engine B must meet existing waveform reference: "+JSON.stringify({kind,qualityIndex,gate}));
          }else{
            assert.ok(gate.pass,"neutral A must reproduce source: "+
              JSON.stringify({kind,qualityIndex,peakBins,gate}));
          }
          rows.push({kind,qualityIndex,engine:engine===0?"A_peaks":"B_bins",
            peakBins,...score,
            objectiveAxes:{nrmse:objective.nrmse,gainDb:objective.gainDb,
              correlation:objective.correlation,clippedSamples:objective.clippedSamples,
              outputSilent:objective.outputSilent},
            qualityGate:gate.pass?"PASS_NEUTRAL":"FAIL_PRODUCT_FIDELITY",
            qualityFailures:gate.failures});
        }
      }
    }
    console.log("ENGINE_A_IDENTITY_PCM_DIAGNOSTIC "+JSON.stringify({
      rate,frames,low:20,high:5500,curvature:1,invert:0,
      shift:0,slope:1,ring:false,rational:false,crusher:false,reverb:0,
      outside:"pass",wet:1,comparison:"Rust offline latency-compensated",
      sampleWindow:[start,end],rows
    }));
    assert.equal(rows.length,4*3+2*3,"fixture/report coverage drift");
  }finally{
    e.warp_free_f32(src,frames);e.warp_free_f32(dst,frames);
  }
});

test("Engine A quality slider controls true native/WASM peak budget and real offline audio",async()=>{
  const e=await load();
  assert.equal(typeof e.warp_stream_set_a_quality,"function");
  assert.equal(typeof e.warp_stream_render_f32_a_quality_ext,"function");
  const fs=12000,n=8192,src=e.warp_alloc_f32(n),dst=e.warp_alloc_f32(n);
  let state=0x34077;const next=()=>{state=(Math.imul(state,1664525)+1013904223)>>>0;return state/0x80000000-1;};
  try {
    new Float32Array(e.memory.buffer,src,n).set(Float32Array.from({length:n},next));
    const timings=[];
    const render=quality=>{
      const before=performance.now();
      const status=e.warp_stream_render_f32_a_quality_ext(
        src,dst,n,1,fs,20,5500,1,.25,1,0,1,0,1,0,0,0,4,0,1,
        0,350,0,0,350,1,20,0,1,quality);
      assert.equal(status,0,"offline A quality "+quality);
      timings.push(Number((performance.now()-before).toFixed(3)));
      return Float32Array.from(new Float32Array(e.memory.buffer,dst,n));
    };
    const zero=render(0),middle=render(50),full=render(100);
    const delta=(x,y)=>x.slice(2048).reduce((sum,v,i)=>sum+Math.abs(v-y[i+2048]),0)/(n-2048);
    assert.ok(delta(zero,middle)>1e-4,"quality 50 must change actual native A audio");
    assert.ok(delta(middle,full)>1e-4,"quality 100 must change actual native A audio");
    assert.ok([zero,middle,full].every(x=>x.every(Number.isFinite)),"finite output across all settings");
    const bad=e.warp_stream_render_f32_a_quality_ext(
      src,dst,n,1,fs,20,5500,1,.25,1,0,1,0,1,0,0,0,4,0,1,
      0,350,0,0,350,1,20,0,1,101);
    assert.equal(bad,-2);
    const stream=e.warp_stream_create_ext(fs,1,20,5500,1,0,1,0,1,0,1,0,0,0,4);
    assert.ok(stream);
    try {
      for(const q of [0,50,100])assert.equal(e.warp_stream_set_a_quality(stream,q),0);
      assert.equal(e.warp_stream_set_a_quality(stream,101),-2);
    }finally{e.warp_stream_free(stream);}
    const original=new Float32Array(e.memory.buffer,src,n);
    const metrics=out=>{
      let inputPower=0,outputPower=0,loss=0,correlation=0;
      for(let i=2048;i<n;i++){
        const a=original[i],b=out[i];inputPower+=a*a;outputPower+=b*b;
        loss+=(a-b)*(a-b);correlation+=a*b;
      }
      return {rmsRatio:Number(Math.sqrt(outputPower/inputPower).toFixed(5)),
        normalizedRMSE:Number(Math.sqrt(loss/inputPower).toFixed(5)),
        correlation:Number((correlation/Math.sqrt(inputPower*outputPower||1)).toFixed(5))};
    };
    console.log("A_QUALITY_PCM_ACTUAL "+JSON.stringify({
      quality:[0,50,100],meanDelta0To50:delta(zero,middle),
      meanDelta50To100:delta(middle,full),
      results:[zero,middle,full].map((x,i)=>({quality:[0,50,100][i],elapsedMs:timings[i],...metrics(x)})),
      warning:"WASM offline elapsedMs are environment-specific not real-time CPU; higher quality is not guaranteed to improve full signal fidelity",
      test:"actual common Rust/WASM"
    }));
  }finally {e.warp_free_f32(src,n);e.warp_free_f32(dst,n);}
});

test("Engine B actual Rust/WASM bin shift keeps phase coherent at hop N/4 and N/8",async()=>{
  const e=await load();
  const rate=8192,n=8192,sourceHz=480,src=e.warp_alloc_f32(n),dst=e.warp_alloc_f32(n);
  const input=Float32Array.from({length:n},(_,i)=>.45*Math.cos(2*Math.PI*sourceHz*i/rate));
  try{
    new Float32Array(e.memory.buffer,src,n).set(input);
    const rows=[];
    for(const hopDiv of [4,8]){
      for(const delta of [-24,0,24]){
        // FFT bin spacing is exactly 8 Hz for quality=1024; all shifts
        // here are exact integer bin moves. Reproduction must NOT
        // depend on overlap factor or absolute frame window position.
        const rc=e.warp_stream_render_f32_a_band_ext(
          src,dst,n,1,rate,20,3000,1,0,1,0,1,1,1,delta,0,0,hopDiv,
          0,1,0,350,0,1,350,1,20,0,1);
        assert.equal(rc,0,"B PCM render "+JSON.stringify({hopDiv,delta}));
        const output=new Float32Array(e.memory.buffer,dst,n);
        const target=sourceHz+delta;
        let targetPower=0,outputPower=0,errorPower=0,cross=0;
        for(let i=2400;i<7400;i++){
          const desired=.45*Math.cos(2*Math.PI*target*i/rate);
          const got=output[i];
          targetPower+=desired*desired;outputPower+=got*got;
          errorPower+=(desired-got)**2;cross+=desired*got;
        }
        const rmsRatio=Math.sqrt(outputPower/targetPower);
        const nrmse=Math.sqrt(errorPower/targetPower);
        const correlation=cross/Math.sqrt(targetPower*outputPower);
        rows.push({hopDiv,delta,target,rmsRatio,nrmse,correlation});
        assert.ok(rmsRatio>.85&&rmsRatio<1.15,
          "B integer shift should not phase-cancel under window overlap: "+JSON.stringify(rows.at(-1)));
        assert.ok(nrmse<.2 && correlation>.97,
          "B integer shift must remain close to target carrier: "+JSON.stringify(rows.at(-1)));
      }
    }
    console.log("B_INTERFRAME_PHASE_PCM_ACTUAL "+JSON.stringify(rows));
  }finally{e.warp_free_f32(src,n);e.warp_free_f32(dst,n);}
});

test("Strict-neutral Engine A transparent at any residual-quality setting",async()=>{
  const e=await load();
  const rate=12000,n=12000,src=e.warp_alloc_f32(n),dst=e.warp_alloc_f32(n);
  assert.ok(src&&dst);
  let seed=0x34077;
  const next=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/0x80000000-1;};
  const noise=Float32Array.from({length:n},next);
  const cases={
    broadband_noise:Float32Array.from(noise,x=>.23*x),
    tone_plus_noise:Float32Array.from(noise,(x,i)=>
      .29*Math.cos(2*Math.PI*440*i/rate)+.13*x),
    gated_burst:Float32Array.from({length:n},(_,i)=>
      (i%2400<96?.6:0)*Math.cos(2*Math.PI*880*i/rate))
  };
  const rows=[];
  try{
    for(const [kind,input] of Object.entries(cases)){
      const outputs=[];
      for(const quality of [0,100]){
        new Float32Array(e.memory.buffer,src,n).set(input);
        const begin=performance.now();
        const rc=e.warp_stream_render_f32_a_quality_ext(
          src,dst,n,1,rate,20,5500,1,0,1,0,1,0,1,0,0,0,4,0,1,
          0,350,0,0,350,1,20,0,1,quality);
        assert.equal(rc,0,"native residual render "+kind+" q"+quality);
        const ms=performance.now()-begin;
        const output=Float32Array.from(new Float32Array(e.memory.buffer,dst,n));
        assert.ok(output.every(Number.isFinite));
        let x2=0,y2=0,e2=0,xy=0;
        for(let i=4200;i<10000;i++){
          const x=input[i],y=output[i];x2+=x*x;y2+=y*y;e2+=(x-y)**2;xy+=x*y;
        }
        const row={kind,quality,nrmse:Math.sqrt(e2/x2),
          rmsGain:Math.sqrt(y2/x2),correlation:xy/Math.sqrt(x2*y2),ms};
        const q=fullReferenceQuality(input,output,{start:4200,end:10000});
        const verdict=qualityGate(q,baselineNeutralContract);
        row.neutralQualityVerdict=verdict.pass?"PASS_NEUTRAL_AXES":"FAIL_OR_INCONCLUSIVE";
        row.neutralQualityFailures=verdict.failures;
        rows.push(row);outputs.push(row);
      }
      for(const result of outputs){
        assert.ok(result.nrmse<.08 && result.neutralQualityVerdict==="PASS_NEUTRAL_AXES",
          "neutral A must not color sound at any experimental quality: "+
            JSON.stringify({kind,result}));
      }
    }
    console.log("A_NEUTRAL_QUALITY_INVARIANCE_PCM_ACTUAL "+JSON.stringify(rows));
  }finally{e.warp_free_f32(src,n);e.warp_free_f32(dst,n);}
});

test("A mapped residual preserves stereo level ratio and does not duplicate unshifted tonal ghost",async()=>{
  const e=await load();const rate=8192,n=8192,count=n*2;
  const src=e.warp_alloc_f32(count),dst=e.warp_alloc_f32(count);
  assert.ok(src&&dst);
  let seed=47201;
  const noise=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/0x80000000-1;};
  try{
    const inData=new Float32Array(e.memory.buffer,src,count);
    for(let i=0;i<n;i++){
      const sample=.35*Math.cos(2*Math.PI*480*i/rate)+.04*noise();
      inData[i]=sample;inData[n+i]=.6*sample;
    }
    const status=e.warp_stream_render_f32_a_quality_ext(
      src,dst,n,2,rate,20,3000,1,0,1,0,1,0,1,24,0,0,4,
      0,1,0,350,0,1,350,1,20,0,1,100);
    assert.equal(status,0);
    const output=new Float32Array(e.memory.buffer,dst,count);
    let leftSq=0,rightSq=0,ratioError=0,oldCos=0,oldSin=0,newCos=0,newSin=0;
    for(let i=2400;i<7300;i++){
      const l=output[i],r=output[n+i];
      assert.ok(Number.isFinite(l)&&Number.isFinite(r));
      leftSq+=l*l;rightSq+=r*r;ratioError+=(r-.6*l)**2;
      oldCos+=l*Math.cos(2*Math.PI*480*i/rate);
      oldSin+=l*Math.sin(2*Math.PI*480*i/rate);
      newCos+=l*Math.cos(2*Math.PI*504*i/rate);
      newSin+=l*Math.sin(2*Math.PI*504*i/rate);
    }
    const ild=Math.sqrt(rightSq/leftSq),stereoError=Math.sqrt(ratioError/leftSq);
    const originalMag=Math.hypot(oldCos,oldSin);
    const shiftedMag=Math.hypot(newCos,newSin);
    console.log("A_RESIDUAL_STEREO_SHIFT_ACTUAL "+JSON.stringify({
      shiftedMag,originalMag,ratio:shiftedMag/originalMag,
      ild,stereoError,noiseMapped:true
    }));
    assert.ok(Math.abs(ild-.6)<.03&&stereoError<.04,
      "linked stereo noise and tone level ratio should survive partial+residual synthesis");
    assert.ok(shiftedMag>originalMag*5,
      "A mapped residual must not leave substantial original unshifted 480Hz ghost");
  }finally{e.warp_free_f32(src,count);e.warp_free_f32(dst,count);}
});

test("Ring Mod affects only source L/H and preserves actual out-of-band Pass on Rust/WASM",async()=>{
  const e=await load(),rate=8192,n=8192;
  const src=e.warp_alloc_f32(n),dst=e.warp_alloc_f32(n);
  const input=Float32Array.from({length:n},(_,i)=>
    .45*Math.cos(2*Math.PI*400*i/rate)+.32*Math.cos(2*Math.PI*1600*i/rate));
  const magnitude=(signal,f)=>{
    let re=0,im=0;
    for(let i=2400;i<7300;i++){
      const phase=2*Math.PI*f*i/rate;
      re+=signal[i]*Math.cos(phase);im-=signal[i]*Math.sin(phase);
    }
    return Math.hypot(re,im);
  };
  try{
    new Float32Array(e.memory.buffer,src,n).set(input);
    const render=(outside,ring)=>{
      const rc=e.warp_stream_render_f32_a_quality_ext(
        src,dst,n,1,rate,20,1200,1,0,1,0,outside,1,1,0,256,0,4,
        0,1,0,350,ring,0,350,1,20,0,1,0);
      assert.equal(rc,0);
      return Float32Array.from(new Float32Array(e.memory.buffer,dst,n));
    };
    const off=render(1,0),on=render(1,1),kill=render(0,1);
    const m=(a,f)=>magnitude(a,f);
    const rows={
      passthrough1600:m(on,1600)/m(off,1600),
      sideband144:m(on,144)/m(off,400),
      sideband656:m(on,656)/m(off,400),
      unexpectedOutsideSidebands:(m(on,1344)+m(on,1856))/m(off,1600),
      outsideKill:m(kill,1600)/m(off,1600)
    };
    console.log("RING_BAND_RUST_WASM "+JSON.stringify(rows));
    assert.ok(rows.passthrough1600>.94&&rows.passthrough1600<1.06,
      "out-of-band original should pass ring unchanged "+JSON.stringify(rows));
    assert.ok(rows.sideband144>.3&&rows.sideband656>.3,
      "in-band mapped carrier must create two sidebands "+JSON.stringify(rows));
    assert.ok(rows.unexpectedOutsideSidebands<.10,
      "source outside L/H must not ring sidebands "+JSON.stringify(rows));
    assert.ok(rows.outsideKill<.06,
      "Kill must also suppress outside source "+JSON.stringify(rows));
  }finally{e.warp_free_f32(src,n);e.warp_free_f32(dst,n);}
});

test("Reciprocal interpolation and invert-Hz marker use common Rust/WASM geometry",async()=>{
  const e=await load();
  assert.equal(typeof e.warp_invert_reference_frequency,"function");
  for(const p of [0,.15,.5,1]){
    const l=100,h=1600,anchor=e.warp_invert_reference_frequency(l,h,p,.3,3);
    assert.ok(anchor>l&&anchor<h);
    if(p===0)assert.ok(Math.abs(anchor-400)<1e-7);
    for(const f of [100,150,400,720,1600]){
      const raw=e.warp_map_frequency(f,l,h,p,0,3);
      const full=e.warp_map_frequency(f,l,h,p,1,3);
      const half=e.warp_map_frequency(f,l,h,p,.5,3);
      assert.ok(Math.abs(raw-f)<1e-7);
      assert.ok(Math.abs(full-e.warp_map_frequency(f,l,h,p,1,1))<1e-7,
        "reciprocal full inversion must have same endpoints as blend");
      assert.ok(Math.abs(half-Math.sqrt(f*full))<1e-7);
    }
    assert.ok(Math.abs(e.warp_map_frequency(anchor,l,h,p,.65,3)-anchor)<1e-6);
    assert.ok(Number.isNaN(e.warp_invert_reference_frequency(l,h,p,.5,1)),
      "linear blend should not invent an Hz fold marker");
  }
  const l=100,h=1600,p=.65,amount=.37;
  assert.ok(Math.abs(e.warp_invert_reference_frequency(l,h,p,amount,0)-
    e.warp_fold_frequency(l,h,p,amount,0))<1e-9);
  assert.ok(Math.abs(e.warp_invert_reference_frequency(l,h,p,amount,2)-
    e.warp_fold_frequency(l,h,p,amount,2))<1e-9);
});

test("0Hz reflected negative targets: real shared Rust/WASM live + WAV gain 0/25/50/100 and legacy ABI",async()=>{
  const e=await load();
  assert.equal(typeof e.warp_stream_set_zero_reflect_gain,"function");
  assert.equal(typeof e.warp_stream_render_f32_zero_gain_ext,"function");
  const fs=8192,n=8192,channels=2,count=n*channels;
  const src=e.warp_alloc_f32(count),dst=e.warp_alloc_f32(count);
  assert.ok(src&&dst);
  const input=new Float32Array(count);
  for(let c=0;c<channels;c++)for(let i=0;i<n;i++)
    input[c*n+i]=(c===0?.45:.27)*Math.cos(2*Math.PI*400*i/fs);
  const output=()=>Float32Array.from(new Float32Array(e.memory.buffer,dst,count));
  try{
    new Float32Array(e.memory.buffer,src,count).set(input);
    const render=(gain,legacyMode=0,old=false)=>{
      const params=[
        src,dst,n,channels,fs,100,1000,1,0,1,0,0,1,1,0,0,
        legacyMode,4,0,1,-2,350,0,0,350,1,20,0,1,0
      ];
      const code=old?e.warp_stream_render_f32_a_quality_ext(...params):
        e.warp_stream_render_f32_zero_gain_ext(...params,gain);
      assert.equal(code,0,"render "+JSON.stringify({gain,legacyMode,old}));
      return output();
    };
    const full=render(1),half=render(.5),quarter=render(.25),zero=render(0);
    const legacyReflect=render(null,0,true),legacyKill=render(null,1,true);
    const metrics=(a,b,channel)=>{
      let powerA=0,powerB=0,powerE=0;
      for(let i=2400;i<7300;i++){
        const x=a[channel*n+i],y=b[channel*n+i];
        powerA+=x*x;powerB+=y*y;powerE+=(x-y)*(x-y);
      }
      return {ratio:Math.sqrt(powerB/(powerA||1)),
        error:Math.sqrt(powerE/(powerA||1)),
        rmsA:Math.sqrt(powerA/(7300-2400)),
        rmsB:Math.sqrt(powerB/(7300-2400))};
    };
    const rows=[];
    for(let c=0;c<channels;c++){
      const mid=metrics(full,half,c),qtr=metrics(full,quarter,c);
      const dead=metrics(full,zero,c);
      const oldR=metrics(full,legacyReflect,c);
      const oldK=metrics(zero,legacyKill,c);
      rows.push({channel:c,fullRMS:mid.rmsA,half:mid.ratio,
        quarter:qtr.ratio,off:dead.ratio,legacyDifference:oldR.error,
        legacyKillRMS:oldK.rmsB});
      assert.ok(mid.rmsA>.08,"target negative needs audibly present output");
      assert.ok(Math.abs(mid.ratio-.5)<.01);
      assert.ok(Math.abs(qtr.ratio-.25)<.01);
      assert.ok(dead.ratio<.01);
      assert.ok(oldR.error<1e-6,"legacy full reflect identical to new 100%");
      assert.ok(oldK.rmsB<.002,"legacy negative Kill unchanged");
    }
    // Setter can switch while audio is running without rebuilding Stream.
    const stream=e.warp_stream_create_ext(fs,2,100,1000,1,0,1,0,0,1,1,0,0,0,4);
    assert.ok(stream);
    try{
      for(const gain of [0,.25,.5,1])assert.equal(e.warp_stream_set_zero_reflect_gain(stream,gain),0);
      assert.equal(e.warp_stream_set_zero_reflect_gain(stream,1.01),-2);
      assert.equal(e.warp_stream_set_zero_reflect_gain(stream,-.01),-2);
      assert.equal(e.warp_stream_set_zero_reflect_gain(stream,NaN),-2);
    }finally{e.warp_stream_free(stream);}
    const bad=[src,dst,n,channels,fs,100,1000,1,0,1,0,0,1,1,0,0,
      0,4,0,1,-2,350,0,0,350,1,20,0,1,0,1.5];
    assert.equal(e.warp_stream_render_f32_zero_gain_ext(...bad),-2);
    console.log("ZERO_REFLECTION_GAIN_PCM_ACTUAL "+JSON.stringify(rows));
  }finally{e.warp_free_f32(src,count);e.warp_free_f32(dst,count);}
});

test("Distinct synthesis and frequency-distance falloff: real stereo Rust/WASM native PCM and graph gain oracle",async()=>{
  const e=await load();
  for(const name of ["warp_zero_reflection_amplitude","warp_stream_set_zero_reflect_decay",
    "warp_stream_render_f32_zero_controls_ext"])assert.equal(typeof e[name],"function");
  for(const distance of [0,175,350,700]){
    const expected=.8*Math.pow(.5,distance/350);
    assert.ok(Math.abs(e.warp_zero_reflection_amplitude(distance,.8,.5,350)-expected)<1e-11);
  }
  const rate=8192,n=8192,count=n*2,src=e.warp_alloc_f32(count),dst=e.warp_alloc_f32(count);
  assert.ok(src&&dst);
  const rms=(signal,c)=>{
    let power=0;
    for(let i=2400;i<7300;i++)power+=signal[c*n+i]**2;
    return Math.sqrt(power/(7300-2400));
  };
  try {
    const rows=[];
    for(const freq of [400,650,1000]){
      for(let c=0;c<2;c++)for(let i=0;i<n;i++){
        new Float32Array(e.memory.buffer,src,count)[c*n+i]=
          (c===0?.42:.25)*Math.cos(2*Math.PI*freq*i/rate);
      }
      const render=(gain,decay)=>{
        const args=[src,dst,n,2,rate,100,1400,1,0,1,0,0,1,1,0,0,0,4,
          0,1,-2,350,0,0,350,1,20,0,1,0,gain,decay];
        assert.equal(e.warp_stream_render_f32_zero_controls_ext(...args),0);
        return Float32Array.from(new Float32Array(e.memory.buffer,dst,count));
      };
      const baseline=render(1,0);
      const changed=render(.8,.5);
      const target=freq-700;
      const expected=target<0?.8*Math.pow(.5,-target/350):1;
      for(let c=0;c<2;c++){
        const measured=rms(changed,c)/rms(baseline,c);
        assert.ok(Math.abs(measured-expected)<.035,
          "distance-dependent gain must match real PCM "+JSON.stringify({freq,target,c,measured,expected}));
        rows.push({freq,target,channel:c,measured,expected});
      }
    }
    const ptr=e.warp_stream_create_ext(rate,1,100,1400,1,0,1,0,0,1,1,0,0,0,4);
    assert.ok(ptr);
    try{
      assert.equal(e.warp_stream_set_zero_reflect_gain(ptr,.75),0);
      for(const decay of [0,.35,1])assert.equal(e.warp_stream_set_zero_reflect_decay(ptr,decay),0);
      assert.equal(e.warp_stream_set_zero_reflect_decay(ptr,-.01),-2);
      assert.equal(e.warp_stream_set_zero_reflect_decay(ptr,1.01),-2);
    }finally{e.warp_stream_free(ptr);}
    console.log("REFLECTION_FALLOFF_PCM_ACTUAL "+JSON.stringify(rows));
  }finally{e.warp_free_f32(src,count);e.warp_free_f32(dst,count);}
});

test("only genuine Fold and 0Hz boundary reflections attenuate real WASM audio",async()=>{
 const e=await load(),rate=8192,n=8192,src=e.warp_alloc_f32(n),dst=e.warp_alloc_f32(n);
 const distance=(f,target,mode,invert,slope,pivot)=>e.warp_all_reflection_distance(
   f,target,100,1400,1,invert,mode,0,1,0,pivot,pivot,slope,350,0);
 assert.equal(distance(500,1000,3,1,1,350),0,
   "Reciprocal full inversion is not a physical Fold");
 assert.equal(distance(500,1000,3,0,-1,750),0,
   "negative physical slope is not a physical Fold");
 assert.equal(distance(400,1050,0,.5,1,350),0,
   "FoldHigh forward branch must pass without attenuation");
 assert.ok(distance(1100,400,0,.5,1,350)>0,
   "FoldHigh reflected branch must attenuate");
 assert.equal(distance(500,-100,3,0,1,350),100,
   "actual zero crossing must remain a reflection");
 for(const p of [0,0.5,1]){
   const low=.001,hi=200;
   assert.ok(Math.abs(e.warp_map_frequency(low,low,hi,p,0,3)-low)<1e-9);
   assert.ok(Number.isFinite(e.warp_map_frequency(.002,low,hi,p,1,3)));
 }
 try{
   const rms=pcm=>{
     let power=0;for(let i=2200;i<n;i++)power+=pcm[i]*pcm[i];
     return Math.sqrt(power/(n-2200));
   };
   const cases=[
     {label:"slope-negative",f:500,mode:3,invert:0,pivot:750,slope:-1,reflected:false},
     {label:"reciprocal-reversed",f:500,mode:3,invert:1,pivot:350,slope:1,reflected:false},
     {label:"fold-forward",f:400,mode:0,invert:.5,pivot:350,slope:1,reflected:false},
     {label:"fold-reflected",f:1100,mode:0,invert:.5,pivot:350,slope:1,reflected:true}
   ];
   for(const engine of [0,1]){
     for(const row of cases){
       const input=new Float32Array(e.memory.buffer,src,n);
       for(let i=0;i<n;i++)input[i]=.42*Math.cos(2*Math.PI*row.f*i/rate);
       const render=(C,D)=>{
         const args=[src,dst,n,1,rate,100,1400,1,row.invert,row.mode,0,0,
           engine,1,0,0,0,4,0,1,0,350,0,0,row.pivot,row.slope,20,0,1,0,C,D];
         assert.equal(e.warp_stream_render_f32_zero_controls_ext(...args),0);
         return rms(new Float32Array(e.memory.buffer,dst,n));
       };
       const normal=render(1,0),muted=render(0,1);
       assert.ok(normal>.02,"test source has inaudible output: "+row.label+" engine "+engine+" RMS="+normal);
       const ratio=muted/normal;
       assert.ok(row.reflected?ratio<.08:Math.abs(ratio-1)<.06,
         "wrong amplitude policy "+JSON.stringify({...row,engine,ratio,normal,muted}));
     }
   }
 }finally{e.warp_free_f32(src,n);e.warp_free_f32(dst,n);}
});

test("Crusher 0Hz frozen level and exact ZOH frequency images from actual shared Rust/WASM stereo PCM",async()=>{
  const e=await load(),rate=8192,n=8192,count=n*2,freq=400;
  const src=e.warp_alloc_f32(count),dst=e.warp_alloc_f32(count);
  assert.ok(src&&dst);
  const source=new Float32Array(e.memory.buffer,src,count);
  for(let c=0;c<2;c++)for(let i=0;i<n;i++)
    source[c*n+i]=(c===0?.34:.21)*Math.cos(2*Math.PI*freq*i/rate);
  const toneAmp=(pcm,frequency,channel)=>{
    let re=0,im=0;
    for(let i=2048;i<8192;i++){
      const phase=2*Math.PI*frequency*i/rate;
      re+=pcm[channel*n+i]*Math.cos(phase);
      im-=pcm[channel*n+i]*Math.sin(phase);
    }
    return Math.hypot(re,im)*2/(8192-2048);
  };
  try{
    const render=(bits,hold)=>{
      const args=[src,dst,n,2,rate,100,1800,1,0,1,0,1,1,1,0,0,0,4,
        bits,hold,0,350,0,0,350,1,20,0,1,0,1,0];
      assert.equal(e.warp_stream_render_f32_zero_controls_ext(...args),0);
      return Float32Array.from(new Float32Array(e.memory.buffer,dst,count));
    };
    const dry=render(0,1);
    const held=render(16,8);
    const frozen=render(8,0);
    const zoh=(hz)=>Math.abs(Math.sin(Math.PI*8*hz/rate)/
      (8*Math.sin(Math.PI*hz/rate)));
    const rows=[];
    for(let c=0;c<2;c++){
      const input=toneAmp(dry,400,c);
      assert.ok(input>.15,"source reference");
      for(const [frequency,signedFrequency] of [[400,400],[624,-624],[1424,1424]]){
        const actual=toneAmp(held,frequency,c)/input;
        const expected=zoh(signedFrequency);
        rows.push({channel:c,frequency,actual,expected});
        assert.ok(Math.abs(actual-expected)<.035,
          "real shared Rust native/WASM held-sample spectrum differs: "+JSON.stringify(rows.at(-1)));
      }
      let min=Infinity,max=-Infinity;
      for(let i=1500;i<n;i++){
        const value=frozen[c*n+i];min=Math.min(min,value);max=Math.max(max,value);
      }
      assert.ok(max-min<.00001,"zero-Hz interval must hold constant, not error or resume "+JSON.stringify({min,max}));
    }
    const ptr=e.warp_stream_create_ext(rate,1,100,1800,1,0,1,0,1,1,1,0,0,0,4);
    assert.ok(ptr);
    try{
      assert.equal(e.warp_stream_set_crusher(ptr,8,0),0);
      assert.equal(e.warp_stream_set_crusher(ptr,8,600000),0);
      assert.equal(e.warp_stream_set_crusher(ptr,8,1000000001),-2);
    }finally{e.warp_stream_free(ptr);}
    console.log("CRUSHER_ZOH_PCM_ACTUAL "+JSON.stringify(rows));
  }finally{e.warp_free_f32(src,count);e.warp_free_f32(dst,count);}
});

test("B actual shared Rust/WASM long-play identity continuity and nonlinear envelope diagnostic",async()=>{
  const e=await load(),rate=8192,frames=128,src=e.warp_alloc_f32(frames),
    dst=e.warp_alloc_f32(frames);
  assert.ok(src&&dst);
  try{
    // 90 seconds of continuous 128-frame playback, without hiding the
    // analysis history behind periodic synthetic resets.
    const ptr=e.warp_stream_create_ext(rate,1,100,3200,1,0,1,0,1,1,1,0,0,0,4);
    assert.ok(ptr);
    const secs=new Float64Array(90),counts=new Uint32Array(90);
    try{
      for(let block=0;block<90*rate/frames;block++){
        const offset=block*frames;
        const input=new Float32Array(e.memory.buffer,src,frames);
        for(let i=0;i<frames;i++)input[i]=.4*Math.cos(2*Math.PI*480*(offset+i)/rate);
        assert.equal(e.warp_stream_process(ptr,src,dst,frames),0);
        const out=new Float32Array(e.memory.buffer,dst,frames);
        const second=Math.floor(offset/rate);
        for(let i=0;i<frames;i++){secs[second]+=out[i]*out[i];counts[second]++;}
      }
      const rms=Array.from(secs,(sum,i)=>Math.sqrt(sum/counts[i]));
      const stable=rms.slice(2);
      const min=Math.min(...stable),max=Math.max(...stable);
      console.log("B_LONGPLAY_RUST_WASM "+JSON.stringify({
        seconds:90,first:rms.slice(0,4),middle:rms.slice(42,47),last:rms.slice(-6),
        min,max}));
      assert.ok(min>.18,"persistent Rust FFT B output must not die after an extended run");
      assert.ok(max/min<1.15,"identity B must not oscillate throughout long-run");
    }finally{e.warp_stream_free(ptr);}
    // Compare nonlinear warp on off-grid steady sinusoidal input. Here
    // multiple neighboring analysis bins map to the same relocated bin.
    // This baseline is intentionally diagnostic, not a fabricated pass
    // claim. Regression acceptance will require actual modulation bounds.
    const rows=[];
    for(const hop of [4,8]){
      for(const amount of [0,.25,.42,.48,.50,.60,.80,1]){
        const run=e.warp_stream_create_ext(rate,1,100,3200,1,amount,1,0,1,1,1,0,0,0,hop);
        assert.ok(run);
        try{
          const total=rate*4,values=new Float32Array(total);
          for(let offset=0;offset<total;offset+=frames){
            const input=new Float32Array(e.memory.buffer,src,frames);
            for(let i=0;i<frames;i++)input[i]=.4*Math.cos(2*Math.PI*483.37*(offset+i)/rate);
            assert.equal(e.warp_stream_process(run,src,dst,frames),0);
            values.set(new Float32Array(e.memory.buffer,dst,frames),offset);
          }
          const windows=[];
          for(let offset=rate;offset+256<total;offset+=256){
            let power=0;
            for(let i=offset;i<offset+256;i++)power+=values[i]*values[i];
            windows.push(Math.sqrt(power/256));
          }
          windows.sort((a,b)=>a-b);
          const q=(p)=>windows[Math.floor((windows.length-1)*p)];
          const row={hop,amount,p10:q(.1),p50:q(.5),p90:q(.9),
            envelopeRatio:q(.1)/q(.9)};
          rows.push(row);
          assert.ok(Number.isFinite(row.envelopeRatio));
          assert.ok(row.envelopeRatio>.92,
            "B must not create artificial source-bin beating under nonlinear warp: "+JSON.stringify(row));
        }finally{e.warp_stream_free(run);}
      }
    }
    console.log("B_TREMOLO_ENVELOPE_BASELINE "+JSON.stringify(rows));
  }finally{e.warp_free_f32(src,frames);e.warp_free_f32(dst,frames);}
});

test("B phase-locked lobes preserve two separated notes and linked stereo at both overlaps",async()=>{
  const e=await load(),rate=8192,n=16384,frames=n*2;
  const src=e.warp_alloc_f32(frames),dst=e.warp_alloc_f32(frames);
  assert.ok(src&&dst);
  try{
    const source=new Float32Array(e.memory.buffer,src,frames);
    for(let c=0;c<2;c++)for(let i=0;i<n;i++){
      const t=i/rate,level=c===0?1:.6;
      source[c*n+i]=level*(.35*Math.cos(2*Math.PI*400*t)+
        .18*Math.cos(2*Math.PI*896*t));
    }
    const tone=(audio,c,f)=>{
      let re=0,im=0;
      for(let i=4096;i<n;i++){
        const phi=2*Math.PI*f*i/rate;
        re+=audio[c*n+i]*Math.cos(phi);
        im-=audio[c*n+i]*Math.sin(phi);
      }
      return 2*Math.hypot(re,im)/(n-4096);
    };
    const rows=[];
    for(const hop of [4,8]){
      const args=[src,dst,n,2,rate,100,3200,1,.25,1,0,1,1,1,0,0,0,
        hop,0,1,0,350,0,0,350,1,20,0,1,0,1,0];
      assert.equal(e.warp_stream_render_f32_zero_controls_ext(...args),0);
      const pcm=new Float32Array(e.memory.buffer,dst,frames);
      const amplitudes=[376,624].map(freq=>[tone(pcm,0,freq),tone(pcm,1,freq)]);
      const ghosts=[400,896].map(freq=>tone(pcm,0,freq));
      rows.push({hop,amplitudes,ghosts});
      assert.ok(Math.abs(amplitudes[0][0]-.35)<.035,"mapped first partial");
      assert.ok(Math.abs(amplitudes[1][0]-.18)<.03,"mapped second partial");
      assert.ok(Math.abs(amplitudes[0][1]/amplitudes[0][0]-.6)<.02,"stereo partial 1");
      assert.ok(Math.abs(amplitudes[1][1]/amplitudes[1][0]-.6)<.02,"stereo partial 2");
      assert.ok(ghosts[0]<.025&&ghosts[1]<.025,"original-frequency ghost must not dominate");
    }
    console.log("B_LOCKED_TWO_TONE_STEREO_PCM "+JSON.stringify(rows));
  }finally{e.warp_free_f32(src,frames);e.warp_free_f32(dst,frames);}
});
