/**
 * Bounded source -> canonical Rust/WASM Stream -> PCM frame source.
 * No whole-file PCM/WASM allocation and no 40M-sample product limit.
 * A writer consumes readFrames sequentially; it must use an actual bounded sink
 * to achieve constant-memory export. This is NOT yet wired to Web download UI.
 * Owner #332.
 */
const BLOCK=128, CACHE=8192;
const valid=(status,label)=>{if(status!==0)throw Error(label+" rejected by Rust Stream: "+status);};
const mode=s=>s==="blend"?1:s==="fold-l"?2:s==="reciprocal"?3:0;
export function createWasmStreamedRenderSource(e,source,settings,{wet=1}={}){
  const info=source?.info||{},total=info.frames,channels=info.channels,rate=info.sampleRate;
  if(!Number.isSafeInteger(total)||total<1||![1,2].includes(channels)||
     !Number.isFinite(rate)||rate<=0||typeof source.readFrames!=="function")
    throw Error("逐次DSPの入力形式またはチャンネル構成に非対応です");
  if(!Number.isFinite(wet)||wet<0||wet>1)throw Error("Wetの範囲が不正です");
  const names=["memory","warp_alloc_f32","warp_free_f32","warp_stream_create_ext",
    "warp_stream_free","warp_stream_process","warp_stream_latency",
    "warp_stream_set_transform","warp_stream_set_geometry","warp_stream_set_a_options",
    "warp_stream_set_a_band","warp_stream_set_a_quality","warp_stream_set_zero_reflect_gain",
    "warp_stream_set_zero_reflect_decay","warp_stream_set_crusher_exact"];
  for(const n of names)if(typeof e?.[n]!=="function"&&n!=="memory")throw Error("WASM ABIが不足: "+n);
  if(!e.memory)throw Error("WASM memoryがありません");
  const p=settings;
  const stream=e.warp_stream_create_ext(rate,channels,p.low,p.high,p.curvature,p.invert,
    mode(p.mode),p.qualityIndex,p.outside==="pass"?1:0,p.engine,p.pitchRatio,
    p.shiftHz,p.carrierHz,p.zeroMode,p.hopDiv);
  if(!stream)throw Error("Rust Streamを初期化できません");
  let src=0,dst=0,disposed=false;
  const dispose=()=>{
    if(disposed)return;disposed=true;
    if(src)e.warp_free_f32(src,BLOCK*channels);
    if(dst)e.warp_free_f32(dst,BLOCK*channels);
    e.warp_stream_free(stream);
  };
  try{
    valid(e.warp_stream_set_transform(stream,p.axisShift,p.axisReference,
      p.ringEnabled?1:0,p.rationalEnabled?1:0),"軸変換");
    valid(e.warp_stream_set_geometry(stream,p.axisPivot,p.axisSlope),"幾何設定");
    valid(e.warp_stream_set_a_options(stream,p.aMinHz??p.low,p.aReverb),"Engine A");
    valid(e.warp_stream_set_a_band(stream,p.aBandBins),"Aピーク帯域");
    valid(e.warp_stream_set_a_quality(stream,p.aQuality),"A品質");
    valid(e.warp_stream_set_zero_reflect_gain(stream,p.zeroReflectGain),"反射量");
    valid(e.warp_stream_set_zero_reflect_decay(stream,p.zeroReflectDecay),"反射減衰");
    valid(e.warp_stream_set_crusher_exact(stream,p.crusherBits,p.crusherRateHz),"Crusher");
    src=e.warp_alloc_f32(BLOCK*channels);
    dst=e.warp_alloc_f32(BLOCK*channels);
    if(!src||!dst)throw Error("逐次DSP用の固定サイズメモリを確保できません");
  }catch(error){dispose();throw error;}
  const latency=e.warp_stream_latency(stream);
  if(!Number.isSafeInteger(latency)||latency<0||latency>1_000_000){
    dispose();throw Error("Rust Streamの遅延値が不正です");
  }
  let cursor=0,produced=0,pending=null,pendingOffset=0,cache=null,cacheStart=0;
  async function readInput(t,len){
    const count=Math.max(0,Math.min(len,total-t));
    if(count===0)return Array.from({length:channels},()=>new Float32Array(len));
    if(!cache||t<cacheStart||t+count>cacheStart+cache[0].length){
      cacheStart=t;
      cache=await source.readFrames(t,Math.min(CACHE,total-t));
      if(!Array.isArray(cache)||cache.length!==channels||
        cache.some(a=>a.length!==Math.min(CACHE,total-t)))
        throw Error("音源チャンクが不整合です");
    }
    return cache.map(ch=>{
      const result=new Float32Array(len);
      result.set(ch.subarray(t-cacheStart,t-cacheStart+count));
      return result;
    });
  }
  async function processNext(){
    if(cursor>=total+latency)throw Error("逐次DSPで出力可能なサンプルがありません");
    const len=Math.min(BLOCK,total+latency-cursor);
    const input=await readInput(cursor,len);
    // Take fresh views each time: WebAssembly memory can grow between calls.
    const x=new Float32Array(e.memory.buffer,src,BLOCK*channels);
    for(let c=0;c<channels;c++)x.set(input[c],c*len);
    valid(e.warp_stream_process(stream,src,dst,len),"音声処理");
    const y=new Float32Array(e.memory.buffer,dst,BLOCK*channels);
    const drop=Math.max(0,latency-cursor),count=Math.max(0,len-drop);
    const output=Array.from({length:channels},(_,c)=>
      Float32Array.from(y.subarray(c*len+drop,c*len+drop+count)));
    cursor+=len;
    return output;
  }
  async function readFrames(start,count,{signal}={}){
    if(disposed)throw Error("逐次DSPは終了しています");
    if(!Number.isSafeInteger(start)||!Number.isSafeInteger(count)||start!==produced||
       count<0||start+count>total||count>CACHE)
      throw Error("逐次DSPのフレームは昇順・8192以下で要求してください");
    const out=Array.from({length:channels},()=>new Float32Array(count));
    let written=0;
    try{
      while(written<count){
        if(signal?.aborted)throw Error("逐次DSPを中断しました");
        if(!pending||pendingOffset===pending[0].length){
          pending=await processNext();pendingOffset=0;
          if(!pending[0].length)continue;
        }
        const n=Math.min(count-written,pending[0].length-pendingOffset);
        for(let c=0;c<channels;c++)
          out[c].set(pending[c].subarray(pendingOffset,pendingOffset+n),written);
        pendingOffset+=n;written+=n;
      }
      if(wet!==1){
        const dry=await source.readFrames(start,count,{signal});
        for(let c=0;c<channels;c++)
          for(let i=0;i<count;i++)out[c][i]=dry[c][i]*(1-wet)+out[c][i]*wet;
      }
      produced+=count;
      if(produced===total)dispose();
      return out;
    }catch(error){dispose();throw error;}
  }
  return Object.freeze({info:Object.freeze({...info}),latency,readFrames,dispose,
    get consumedFrames(){return produced;}});
}
