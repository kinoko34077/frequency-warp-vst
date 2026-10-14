/**
 * Native Rust core, compiled to wasm32. This worker performs NO DSP in JS.
 * Source-of-truth algorithm: core/src/lib.rs shared with the native C ABI.
 */
let corePromise;
async function core() {
  if (!corePromise) {
    corePromise=(async ()=>{
      const response=await fetch(new URL("./dsp_core.wasm",import.meta.url));
      if (!response.ok) throw new Error("WASMを読み込めません ("+response.status+")。ビルド済みWebサイトを使用してください。");
      const bytes=await response.arrayBuffer();
      const {instance}=await WebAssembly.instantiate(bytes,{});
      const e=instance.exports;
      for(const name of ["memory","warp_alloc_f32","warp_free_f32","warp_stream_render_f32_a_quality_ext"]){
        if(!e[name])throw new Error("WASM ABI不一致: "+name);
      }
      return e;
    })();
  }
  return corePromise;
}

self.onmessage=async ({data})=>{
  if(!data||data.type!=="process")return;
  let src=0,dst=0,count=0;
  let exports;
  try {
    const channels=data.channels.map(ch=>new Float32Array(ch));
    const frames=channels[0]?.length||0;
    if(!(channels.length===1||channels.length===2)||!channels.every(c=>c.length===frames)) {
      throw new Error("チャンネル長が一致しません。");
    }
    count=frames*channels.length;
    if(count>40_000_000)throw new Error("音声が長すぎます（Web版処理上限）。");
    exports=await core();
    src=exports.warp_alloc_f32(count);
    dst=exports.warp_alloc_f32(count);
    if(!src||!dst)throw new Error("DSPメモリを確保できません。");
    const input=new Float32Array(exports.memory.buffer,src,count);
    for(let c=0;c<channels.length;c++)input.set(channels[c],c*frames);
    // Offline file export through the SAME stream as realtime audition. No fake progress.
    self.postMessage({type:"progress",value:0});
    const options=data.settings;
    const start=performance.now();
    const result=exports.warp_stream_render_f32_a_quality_ext(src,dst,frames,channels.length,
      data.sampleRate,options.low,options.high,options.curvature,options.invert,
      options.mode==="blend"?1:options.mode==="fold-l"?2:0,options.qualityIndex,
      options.outside==="pass"?1:0,options.engine,options.pitchRatio,options.shiftHz,
      options.carrierHz,options.zeroMode,options.hopDiv,options.crusherBits,options.crusherHold,
      options.axisShift,options.axisReference,options.ringEnabled?1:0,options.rationalEnabled?1:0,
      options.axisPivot,options.axisSlope,options.aMinHz,options.aReverb,options.aBandBins,options.aQuality);
    if(result!==0)throw new Error("共通DSPの処理に失敗: status "+result);
    const output=new Float32Array(exports.memory.buffer,dst,count);
    const rendered=channels.map((_,c)=>new Float32Array(output.slice(c*frames,(c+1)*frames)));
    const elapsedMs=performance.now()-start;
    self.postMessage({
      type:"done",channels:rendered,
      diagnostics:{
        engine:"Shared Rust streaming DSP / WebAssembly",
        frames:Math.ceil(frames/({0:256,1:256,2:512}[options.qualityIndex]||256)),
        durationSeconds:frames/data.sampleRate,
        elapsedMs
      }
    },rendered.map(x=>x.buffer));
  }catch(error){
    self.postMessage({type:"error",message:error instanceof Error?error.message:String(error)});
  }finally{
    if(exports){
      if(src)exports.warp_free_f32(src,count);
      if(dst)exports.warp_free_f32(dst,count);
    }
  }
};
