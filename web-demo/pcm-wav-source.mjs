/** Compatibility API for the shared bounded WAV source reader (#332 A2). */
import {
  DEFAULT_WAV_READ_BUDGET_BYTES,
  openWavChunkSource
} from "./wav-chunk-source.mjs";

export {DEFAULT_WAV_READ_BUDGET_BYTES};

function legacyError(error){
  if(error?.code==="ABORTED"){
    return new DOMException("Audio read aborted","AbortError");
  }
  if(error?.code==="INVALID_RANGE")
    return new RangeError("PCM WAV: readFrames exceeds source frame range");
  if(error?.code==="CHUNK_TOO_LARGE"||error?.code==="READ_BUDGET_EXCEEDED")
    return new RangeError("PCM WAV: readFrames exceeds per-call read budget");
  if(error?.legacyMessage)return Error("PCM WAV: "+error.legacyMessage);
  const messages={
    INVALID_FILE:"a seekable Blob/File is required",
    INVALID_READ_BUDGET:"invalid read budget",
    NOT_WAV:"not a standard RIFF/WAVE file",
    TRUNCATED:"truncated RIFF chunk",
    BAD_FORMAT:"invalid byte rate or block alignment",
    UNSUPPORTED_PARAMETERS:"unsupported format parameters",
    UNSUPPORTED_RF64:"RF64 requires a separate decoder",
    UNSUPPORTED_CODEC:"unsupported encoding (PCM/IEEE float only)",
    INVALID_CHUNK_SIZE:"invalid chunk size",
    INVALID_SAMPLE:"non-finite floating-point audio sample"
  };
  if(error?.code&&messages[error.code])return Error("PCM WAV: "+messages[error.code]);
  return error;
}

/**
 * Open a seekable PCM-WAV source while preserving the earlier #334 API shape.
 * Parsing and frame decoding are owned by openWavChunkSource; maxReadBytes
 * limits encoded bytes fetched for each frame-read operation. Small metadata
 * slices use the canonical reader's separate fixed metadata bound.
 */
export async function openPcmWavSource(file,{
  signal,maxReadBytes=DEFAULT_WAV_READ_BUDGET_BYTES
}={}){
  let source;
  try{source=await openWavChunkSource(file,{signal,maxReadBytes,legacyDuplicateFmtHandling:true});}
  catch(error){
    if(error?.code==="NOT_WAV"&&file?.size<12)
      throw Error("PCM WAV: incomplete or invalid chunk");
    throw legacyError(error);
  }
  const info=Object.freeze({
    kind:"pcm-wav",format:source.info.format,channels:source.info.channels,
    sampleRate:source.info.sampleRate,blockAlign:source.info.blockAlign,
    bitsPerSample:source.info.bits,sampleBytes:source.info.bytesPerSample,
    sampleFormat:source.info.format===3?"float":"integer",
    frames:source.info.frames,durationSeconds:source.info.durationSeconds,
    byteLength:source.info.dataByteLength,sourceByteLength:source.info.encodedBytes
  });
  const framesPerRead=Math.min(8192,Math.floor(maxReadBytes/source.info.blockAlign));
  async function readFrames(startFrame,count,{signal:readSignal}={}){
    try{
      if(!Number.isSafeInteger(startFrame)||!Number.isSafeInteger(count)||
         startFrame<0||count<0||startFrame+count>info.frames)
        throw RangeError("PCM WAV: readFrames exceeds source frame range");
      if(count*info.blockAlign>maxReadBytes)
        throw RangeError("PCM WAV: readFrames exceeds per-call read budget");
      if(count>0&&framesPerRead<1)
        throw RangeError("PCM WAV: readFrames exceeds per-call read budget");
      const activeSignal=readSignal||signal;
      const result=Array.from({length:info.channels},()=>new Float32Array(count));
      for(let offset=0;offset<count;offset+=framesPerRead){
        const size=Math.min(framesPerRead,count-offset);
        const part=await source.readFrames(startFrame+offset,size,{signal:activeSignal});
        for(let channel=0;channel<info.channels;channel++)result[channel].set(part[channel],offset);
      }
      if(count===0)return await source.readFrames(startFrame,0,{signal:activeSignal});
      return result;
    }catch(error){throw legacyError(error);}
  }
  async function* iterateFrames(options={}){
    try{yield* source.iterateFrames({...options,signal:options.signal||signal});}
    catch(error){throw legacyError(error);}
  }
  return Object.freeze({info,readFrames,iterateFrames});
}
