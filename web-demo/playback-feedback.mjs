// The requested controls and the Rust/WASM-applied revision are distinct.
// A stale ACK may update the historical applied watermark, but must never
// clear a newer pending, rejected or failed user edit.
export function createPlaybackFeedback() {
  let phase="starting",requestedRevision=0,appliedRevision=0,reason="";
  const current=()=>({phase,requestedRevision,appliedRevision,reason});
  return {
    get current(){return current();},
    ready(){if(phase==="starting")phase="applied";return current();},
    request(revision){
      if(!Number.isSafeInteger(revision)||revision<=requestedRevision)
        throw Error("Parameter revision must increase monotonically");
      requestedRevision=revision;phase="pending";reason="";
      return current();
    },
    reject(message){
      phase="rejected";reason=String(message||"設定値が無効です");
      return current();
    },
    rebuild(){
      phase="rebuilding";reason="";
      return current();
    },
    ack(revision){
      if(!Number.isSafeInteger(revision)||revision>requestedRevision||revision<=0)
        return false;
      appliedRevision=Math.max(appliedRevision,revision);
      if(revision!==requestedRevision||phase!=="pending")return false;
      phase="applied";reason="";
      return true;
    },
    fail(revision,message){
      if(revision!==undefined&&
        (!Number.isSafeInteger(revision)||revision!==requestedRevision||phase!=="pending"))
        return false;
      phase="failed";reason=String(message||"音声処理に失敗しました");
      return true;
    }
  };
}
