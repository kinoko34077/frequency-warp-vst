/**
 * Read uncompressed RIFF/WAVE PCM by bounded Blob.slice calls, not whole-file decode.
 * Source metadata and requested frames are never truncated to preview defaults.
 * Ownership: #332.  The consumer decides whether it has a streaming output path.
 */
const FORMATS=new Set([1,3]);
export const DEFAULT_WAV_READ_BUDGET_BYTES=1_048_576;
const MAX_META_READ=64;
export class WavSourceError extends Error {
  constructor(code,message,legacyMessage=null){
    super(message);this.name="WavSourceError";this.code=code;
    if(legacyMessage)this.legacyMessage=legacyMessage;
  }
}
const fail=(code,msg,legacyMessage=null)=>{throw new WavSourceError(code,msg,legacyMessage);};
const fourcc=(v,offset)=>String.fromCharCode(...new Uint8Array(v.buffer,v.byteOffset+offset,4));
async function slice(file,offset,length,signal){
  if(signal?.aborted)fail("ABORTED","読み込みを中断しました");
  if(!Number.isSafeInteger(offset)||!Number.isSafeInteger(length)||offset<0||length<0||offset+length>file.size)
    fail("TRUNCATED","WAVチャンクがファイル範囲外です");
  const result=await file.slice(offset,offset+length).arrayBuffer();
  if(signal?.aborted)fail("ABORTED","読み込みを中断しました");
  if(result.byteLength!==length)fail("TRUNCATED","WAVチャンクが不足しています");
  return new DataView(result);
}
function formatFromView(v){
  if(v.byteLength<16)fail("BAD_FORMAT","WAV fmtが不足しています","short fmt chunk");
  let format=v.getUint16(0,true);
  const channels=v.getUint16(2,true),sampleRate=v.getUint32(4,true);
  const byteRate=v.getUint32(8,true),blockAlign=v.getUint16(12,true),bits=v.getUint16(14,true);
  if(format===65534){
    if(v.byteLength<40||v.getUint16(16,true)<22)
      fail("BAD_FORMAT","WAV拡張fmtが不足しています","short fmt chunk");
    // WAVE_FORMAT_EXTENSIBLE: first four bytes of the canonical subformat GUID.
    const guidTail=[0,0,16,0,128,0,0,170,0,56,155,113];
    const tail=new Uint8Array(v.buffer,v.byteOffset+28,12);
    if(guidTail.some((x,i)=>tail[i]!==x))fail("UNSUPPORTED_CODEC","WAV拡張形式のsubformatが未対応です");
    format=v.getUint32(24,true);
  }
  if(!FORMATS.has(format))fail("UNSUPPORTED_CODEC","未対応のWAV符号化形式です");
  if(channels<1||sampleRate<1||bits%8!==0)
    fail("UNSUPPORTED_PARAMETERS","WAVチャンネル・サンプルレート・ビット深度が未対応です");
  if((format===1&&![8,16,24,32].includes(bits))||
     (format===3&&![32,64].includes(bits)))
    fail("UNSUPPORTED_PARAMETERS","未対応のPCMビット深度です");
  const bytes=bits/8;
  if(blockAlign!==channels*bytes||byteRate!==sampleRate*blockAlign)
    fail("BAD_FORMAT","WAVのブロック長またはバイトレートが矛盾しています");
  return Object.freeze({format,channels,sampleRate,bits,bytesPerSample:bytes,blockAlign});
}
function decodeSample(v,offset,format,bits){
  if(format===3)return bits===32?v.getFloat32(offset,true):v.getFloat64(offset,true);
  if(bits===8)return (v.getUint8(offset)-128)/128;
  if(bits===16)return v.getInt16(offset,true)/32768;
  if(bits===32)return v.getInt32(offset,true)/2147483648;
  // Sign-extend 24-bit two's complement.
  const x=v.getUint8(offset)|(v.getUint8(offset+1)<<8)|(v.getUint8(offset+2)<<16);
  return ((x&0x800000)?x-0x1000000:x)/8388608;
}
export async function openWavChunkSource(file,{
  signal,maxReadBytes=DEFAULT_WAV_READ_BUDGET_BYTES,legacyDuplicateFmtHandling=false
}={}){
  if(!file||!Number.isSafeInteger(file.size)||typeof file.slice!=="function")
    fail("INVALID_FILE","Blob互換ファイルが必要です");
  if(!Number.isSafeInteger(maxReadBytes)||maxReadBytes<1)
    fail("INVALID_READ_BUDGET","WAV読込バイト予算が不正です");
  if(file.size<44)fail("NOT_WAV","RIFF/WAVEヘッダーがありません");
  const head=await slice(file,0,12,signal);
  if(fourcc(head,0)!=="RIFF"||fourcc(head,8)!=="WAVE")
    fail("NOT_WAV","RIFF/WAVEではありません（圧縮形式の扱いは別経路）");
  const riffSize=head.getUint32(4,true);
  if(riffSize===0xFFFFFFFF)fail("UNSUPPORTED_RF64","RF64入力は未対応です");
  const riffEnd=8+riffSize;
  if(riffEnd>file.size||riffEnd<44)
    fail("TRUNCATED","RIFFの宣言サイズがファイルと一致しません","truncated RIFF container");
  let pos=12,format=null,data=null;
  while(pos+8<=riffEnd){
    const header=await slice(file,pos,8,signal);
    const name=fourcc(header,0),n=header.getUint32(4,true);
    const start=pos+8,end=start+n;
    if(end>riffEnd)fail("TRUNCATED","WAVのチャンク終端が不正です","truncated RIFF chunk");
    if(name==="fmt "){
      if(format&&!legacyDuplicateFmtHandling)fail("BAD_FORMAT","重複するWAV fmtです");
      if(!format){
        if(n<16)fail("BAD_FORMAT","WAV fmtが短すぎます","short fmt chunk");
        // Only 40 bytes are needed for canonical PCM/IEEE-float extensible.
        format=formatFromView(await slice(file,start,Math.min(n,MAX_META_READ),signal));
      }
    }else if(name==="data"&&!data)data={offset:start,byteLength:n};
    pos=end+(n&1);
    if(format&&data)break;
  }
  if(!format||!data)fail("BAD_FORMAT","WAV fmtまたはdataがありません","missing fmt or data chunk");
  if(data.byteLength%format.blockAlign!==0)
    fail("TRUNCATED","WAVデータがサンプルフレーム途中で終わっています","partial PCM frame");
  const frames=data.byteLength/format.blockAlign;
  if(!Number.isSafeInteger(frames))fail("UNSUPPORTED_SIZE","フレーム数が安全な整数ではありません");
  const info=Object.freeze({...format,frames,durationSeconds:frames/format.sampleRate,
    dataByteLength:data.byteLength,encodedBytes:file.size,kind:"pcm-wav"});
  async function readFrames(start,count,{signal:readSignal}={}){
    if(!Number.isSafeInteger(start)||!Number.isSafeInteger(count)||start<0||count<0||start+count>frames)
      fail("INVALID_RANGE","WAVフレーム位置が範囲外です");
    // One read must be bounded; read the whole source via iterateFrames below.
    if(count>8192)fail("CHUNK_TOO_LARGE","一度の読込は8192フレーム以内です");
    const byteLength=count*format.blockAlign;
    if(!Number.isSafeInteger(byteLength)||byteLength>maxReadBytes)
      fail("READ_BUDGET_EXCEEDED","WAV読込が1回あたりのバイト予算を超えています");
    const view=await slice(file,data.offset+start*format.blockAlign,byteLength,readSignal);
    const channels=Array.from({length:format.channels},()=>new Float32Array(count));
    for(let i=0;i<count;i++)for(let c=0;c<format.channels;c++){
      const x=decodeSample(view,(i*format.channels+c)*format.bytesPerSample,format.format,format.bits);
      if(!Number.isFinite(x))fail("INVALID_SAMPLE","無限大またはNaNの音声サンプルです");
      channels[c][i]=x;
    }
    return channels;
  }
  async function* iterateFrames({start=0,end=frames,chunkFrames=4096,signal:readSignal}={}){
    if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||end<start||end>frames)
      fail("INVALID_RANGE","WAV走査範囲が不正です");
    if(!Number.isInteger(chunkFrames)||chunkFrames<1||chunkFrames>8192)
      fail("INVALID_CHUNK_SIZE","チャンクは1〜8192フレームが必要です");
    const boundedChunkFrames=Math.min(chunkFrames,Math.floor(maxReadBytes/format.blockAlign));
    if(boundedChunkFrames<1)fail("READ_BUDGET_EXCEEDED","1フレーム分のWAV読込予算がありません");
    for(let at=start;at<end;at+=boundedChunkFrames){
      if(readSignal?.aborted)fail("ABORTED","読み込みを中断しました");
      yield {start:at,channels:await readFrames(at,Math.min(boundedChunkFrames,end-at),{signal:readSignal})};
    }
  }
  return Object.freeze({info,readFrames,iterateFrames});
}
