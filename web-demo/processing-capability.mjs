/**
 * Capability-first source planning. Estimates are workload-specific, never
 * product file-size/time limits. Requested source metadata is immutable.
 * Owner #332; streaming playback remains a separate pending executor.
 */
const MIB=1024*1024;
const fail=(code,message)=>({code,message});
export function availableAudioMemory({heapLimitBytes,heapUsedBytes,deviceMemoryGiB}={}){
  if(Number.isFinite(heapLimitBytes)&&Number.isFinite(heapUsedBytes)&&
     heapLimitBytes>heapUsedBytes&&heapUsedBytes>=0)
    return {bytes:Math.floor((heapLimitBytes-heapUsedBytes)*0.50),basis:"measured-heap-headroom"};
  if(Number.isFinite(deviceMemoryGiB)&&deviceMemoryGiB>0)
    return {bytes:Math.floor(deviceMemoryGiB*1024*MIB*0.20),basis:"coarse-device-memory"};
  return {bytes:null,basis:"unknown"};
}
export function browserAudioMemory(host={}){
  return availableAudioMemory({
    heapLimitBytes:host.performance?.memory?.jsHeapSizeLimit,
    heapUsedBytes:host.performance?.memory?.usedJSHeapSize,
    deviceMemoryGiB:host.navigator?.deviceMemory
  });
}
/** Evaluate a real current *buffered* playback host, not a fictional streamer. */
export function planBufferedPreview(requested,{memory,channelsSupported=2,kind="pcm-wav"}={}){
  const snapshot=Object.freeze({...requested});
  const frames=snapshot.frames,channels=snapshot.channels,rate=snapshot.sampleRate;
  const invalid=!Number.isSafeInteger(frames)||frames<1||
    !Number.isSafeInteger(channels)||channels<1||
    !Number.isFinite(rate)||rate<=0;
  const estimate=invalid?null:frames*channels*4*5;
  const estimates=Object.freeze({
    audioWorkingSetBytes:Number.isSafeInteger(estimate)?estimate:null,
    budgetBytes:memory?.bytes??null,budgetBasis:memory?.basis||"unknown"
  });
  const reasons=[];
  if(invalid)reasons.push(fail("INVALID_SOURCE","音声のフレーム数・チャンネル数・レートが不正です"));
  if(!invalid&&channels>channelsSupported)
    reasons.push(fail("CHANNEL_TOPOLOGY_UNAVAILABLE",channels+"chの音声を保持しましたが、現在の再生DSPは最大"+channelsSupported+"chです。チャンネルを黙って捨てません"));
  if(!invalid&&estimates.audioWorkingSetBytes===null)
    reasons.push(fail("UNSAFE_ALLOCATION","音声処理に必要なメモリ量を安全に計算できません"));
  if(!invalid&&memory?.bytes!==null&&memory?.bytes!==undefined&&
      estimates.audioWorkingSetBytes>memory.bytes)
    reasons.push(fail("INSUFFICIENT_BUFFER_MEMORY",
      "音源は全長保持されていますが、この実行環境の推定空きメモリでは一括再生できません。逐次再生は未実装です"));
  const status=reasons.length?"unavailable":"supported";
  return Object.freeze({requested:snapshot,effective:status==="supported"?snapshot:null,
    status,strategy:status==="supported"?(kind==="pcm-wav"?"wav-bounded-read-buffered-output":"legacy-buffered-decode"):"none",
    reasonCodes:Object.freeze(reasons.map(x=>x.code)),
    reasons:Object.freeze(reasons),estimates});
}
export function planCompressedPredecode(fileSize,{memory}={}){
  if(!Number.isSafeInteger(fileSize)||fileSize<0)
    return {status:"unavailable",reasonCodes:["INVALID_SOURCE"]};
  // Encoded file must be materialized for legacy decodeAudioData; its decoded
  // footprint is not derivable from encoded bytes without codec metadata.
  if(memory?.bytes!==undefined&&memory?.bytes!==null&&fileSize*2>memory.bytes)
    return {status:"unavailable",reasonCodes:["INSUFFICIENT_DECODE_MEMORY"]};
  return {status:"conditional",reasonCodes:memory?.bytes===null?["MEMORY_UNVERIFIED"]:[]};
}
