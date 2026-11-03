/** Bounded PCM-WAV source reader (#332 A2).
 * Parses metadata and reads requested frames with Blob.slice only; it never
 * decodes the entire recording. Does not replace the legacy browser player yet.
 * This reader is not a codec for compressed, RF64, or WAVE_FORMAT_EXTENSIBLE.
 */
export const DEFAULT_WAV_READ_BUDGET_BYTES=1_048_576;

function invalid(reason){throw Error("PCM WAV: "+reason);}
function aborted(signal){
  if(signal?.aborted)throw new DOMException("Audio read aborted","AbortError");
}
function uint(n){return Number.isSafeInteger(n)&&n>=0;}
function ascii(bytes){return String.fromCharCode(...bytes);}
async function bytesAt(file,start,count,signal){
  aborted(signal);
  if(!uint(start)||!uint(count)||start+count>file.size||
     !uint(start+count))invalid("incomplete or invalid chunk");
  const buf=await file.slice(start,start+count).arrayBuffer();
  aborted(signal);
  if(buf.byteLength!==count)invalid("short file read");
  return new DataView(buf);
}
function tag(view,start){return ascii(new Uint8Array(view.buffer,view.byteOffset+start,4));}
function fmtDetails(view){
  const format=view.getUint16(0,true),channels=view.getUint16(2,true),
    sampleRate=view.getUint32(4,true),byteRate=view.getUint32(8,true),
    blockAlign=view.getUint16(12,true),bitsPerSample=view.getUint16(14,true);
  if(format!==1&&format!==3)invalid("unsupported encoding (PCM/IEEE float only)");
  if(channels<1||sampleRate<1||![8,16,24,32].includes(bitsPerSample)||
     (format===3&&bitsPerSample!==32))
    invalid("unsupported format parameters");
  const sampleBytes=bitsPerSample/8;
  if(blockAlign!==sampleBytes*channels||byteRate!==sampleRate*blockAlign)
    invalid("invalid byte rate or block alignment");
  return {format,channels,sampleRate,blockAlign,bitsPerSample,sampleBytes};
}
function decodeSample(view,offset,format,bits){
  if(format===3){
    const n=view.getFloat32(offset,true);
    if(!Number.isFinite(n))invalid("non-finite floating-point audio sample");
    return n;
  }
  switch(bits){
    case 8:return (view.getUint8(offset)-128)/128;
    case 16:return view.getInt16(offset,true)/32768;
    case 24:{
      const raw=view.getUint8(offset)|(view.getUint8(offset+1)<<8)|
        (view.getUint8(offset+2)<<16);
      return (raw&0x800000?raw-0x1000000:raw)/8388608;
    }
    case 32:return view.getInt32(offset,true)/2147483648;
    default:invalid("unsupported sample width");
  }
}
/** Open a RIFF/WAVE PCM source. Reject malformed chunks, but do not cap source
 * duration/encoded size. Per-read memory is separately budgeted.
 */
export async function openPcmWavSource(file,{
  signal,maxReadBytes=DEFAULT_WAV_READ_BUDGET_BYTES
}={}){
  if(!file||!uint(file.size)||typeof file.slice!=="function")
    invalid("a seekable Blob/File is required");
  if(!uint(maxReadBytes)||maxReadBytes<1)invalid("invalid read budget");
  const header=await bytesAt(file,0,12,signal);
  if(tag(header,0)!=="RIFF"||tag(header,8)!=="WAVE")
    invalid("not a standard RIFF/WAVE file");
  const riffSize=header.getUint32(4,true);
  if(riffSize===0xffffffff)invalid("RF64 requires a separate decoder");
  const end=riffSize+8;
  if(end>file.size||end<12)invalid("truncated RIFF container");
  let cursor=12,format=null,data=null;
  while(cursor+8<=end){
    const chunk=await bytesAt(file,cursor,8,signal);
    const kind=tag(chunk,0),size=chunk.getUint32(4,true);
    const start=cursor+8,next=start+size+(size&1);
    if(next>end||!uint(next))invalid("truncated RIFF chunk");
    if(kind==="fmt " && !format){
      if(size<16)invalid("short fmt chunk");
      format=fmtDetails(await bytesAt(file,start,16,signal));
    }else if(kind==="data" && !data){
      data={start,size};
    }
    if(format&&data)break;
    if(next<=cursor)invalid("invalid RIFF chunk size");
    cursor=next;
  }
  if(!format||!data)invalid("missing fmt or data chunk");
  if(data.size%format.blockAlign!==0)invalid("partial PCM frame");
  const frames=data.size/format.blockAlign;
  const info=Object.freeze({
    kind:"pcm-wav",sampleRate:format.sampleRate,channels:format.channels,
    bitsPerSample:format.bitsPerSample,
    sampleFormat:format.format===3?"float":"integer",
    frames,durationSeconds:frames/format.sampleRate,
    byteLength:data.size,sourceByteLength:file.size
  });
  return Object.freeze({
    info,
    async readFrames(startFrame,count,{signal:readSignal}={}){
      const activeSignal=readSignal||signal;
      aborted(activeSignal);
      if(!uint(startFrame)||!uint(count)||!uint(startFrame+count)||
         startFrame+count>frames)
        throw RangeError("PCM WAV: readFrames exceeds source frame range");
      const bytes=count*format.blockAlign;
      if(!uint(bytes)||bytes>maxReadBytes)
        throw RangeError("PCM WAV: readFrames exceeds per-call read budget");
      const channels=Array.from({length:format.channels},()=>new Float32Array(count));
      if(!count)return channels;
      const window=await bytesAt(file,data.start+startFrame*format.blockAlign,bytes,activeSignal);
      for(let i=0;i<count;i++){
        for(let ch=0;ch<format.channels;ch++){
          channels[ch][i]=decodeSample(window,
            i*format.blockAlign+ch*format.sampleBytes,
            format.format,format.bitsPerSample);
        }
      }
      aborted(activeSignal);
      return channels;
    }
  });
}
