/**
 * Sequential PCM16 WAVE encoder with bounded per-chunk allocations.
 * The sink may be a FileSystemWritableFileStream or an in-memory Blob collector.
 * Never hides RIFF's 32-bit length limits; RF64 is emitted for larger files.
 * Owner: #332.
 */
const MAX_U32=0xFFFFFFFFn;
const utf8=(view,offset,s)=>{for(let i=0;i<s.length;i++)view.setUint8(offset+i,s.charCodeAt(i));};
export function pcm16WavHeader({frames,channels,sampleRate}){
  if(!Number.isSafeInteger(frames)||frames<0||
    !Number.isSafeInteger(channels)||channels<1||channels>65535||
    !Number.isSafeInteger(sampleRate)||sampleRate<1||sampleRate>0xFFFFFFFF)
    throw Error("WAV出力のフレーム数・チャンネル数・サンプルレートが不正です");
  if(channels*2>65535||sampleRate*channels*2>0xFFFFFFFF)
    throw Error("PCM16 WAVのブロック長・バイトレートが形式の範囲外です");
  const size=BigInt(frames)*BigInt(channels)*2n;
  const rf64=size+36n>MAX_U32;
  const data=new ArrayBuffer(rf64?80:44),v=new DataView(data);
  if(rf64){
    utf8(v,0,"RF64");v.setUint32(4,0xFFFFFFFF,true);utf8(v,8,"WAVE");
    utf8(v,12,"ds64");v.setUint32(16,28,true);
    v.setBigUint64(20,size+72n,true); // RF64 file length excluding initial 8 bytes
    v.setBigUint64(28,size,true);v.setBigUint64(36,BigInt(frames),true);
    v.setUint32(44,0,true);
    utf8(v,48,"fmt ");v.setUint32(52,16,true);v.setUint16(56,1,true);
    v.setUint16(58,channels,true);v.setUint32(60,sampleRate,true);
    v.setUint32(64,sampleRate*channels*2,true);
    v.setUint16(68,channels*2,true);v.setUint16(70,16,true);
    utf8(v,72,"data");v.setUint32(76,0xFFFFFFFF,true);
  }else{
    utf8(v,0,"RIFF");v.setUint32(4,Number(size+36n),true);utf8(v,8,"WAVE");
    utf8(v,12,"fmt ");v.setUint32(16,16,true);v.setUint16(20,1,true);
    v.setUint16(22,channels,true);v.setUint32(24,sampleRate,true);
    v.setUint32(28,sampleRate*channels*2,true);
    v.setUint16(32,channels*2,true);v.setUint16(34,16,true);
    utf8(v,36,"data");v.setUint32(40,Number(size),true);
  }
  return new Uint8Array(data);
}
const toI16=x=>{const y=Math.max(-1,Math.min(1,x));return Math.round(y*(y<0?32768:32767));};
/**
 * Source readFrames(start,count) -> Array<Float32Array>, exactly 'count'.
 * Uses ≤chunkFrames * channels * 2 output bytes in memory per iteration.
 */
export async function* encodePcm16Wav({frames,channels,sampleRate,readFrames,chunkFrames=8192,signal}){
  if(!Number.isInteger(chunkFrames)||chunkFrames<1||chunkFrames>65536)
    throw Error("WAV書出しチャンクが不正です");
  if(typeof readFrames!=="function")throw Error("readFrames関数が必要です");
  yield pcm16WavHeader({frames,channels,sampleRate});
  for(let start=0;start<frames;start+=chunkFrames){
    if(signal?.aborted)throw Error("WAV書出しを中断しました");
    const count=Math.min(chunkFrames,frames-start);
    const buffers=await readFrames(start,count,{signal});
    if(!Array.isArray(buffers)||buffers.length!==channels||
       buffers.some(x=>!x||x.length!==count))
      throw Error("WAV書出しのチャンク・チャンネル数が不整合です");
    const bytes=new Uint8Array(count*channels*2),view=new DataView(bytes.buffer);
    for(let i=0;i<count;i++)for(let c=0;c<channels;c++){
      const sample=buffers[c][i];
      if(!Number.isFinite(sample))throw Error("WAV書出しに無効な音声サンプルがあります");
      view.setInt16((i*channels+c)*2,toI16(sample),true);
    }
    yield bytes;
  }
}
export async function writePcm16WavToSink({sink,...params}){
  if(!sink||typeof sink.write!=="function")throw Error("出力先が必要です");
  try{
    for await(const data of encodePcm16Wav(params))await sink.write(data);
    if(typeof sink.close==="function")await sink.close();
  }catch(error){
    if(typeof sink.abort==="function")await sink.abort(error).catch(()=>{});
    throw error;
  }
}
