/** #321: processing interval has strict L < H, without a percent-width floor. */
function nextPositive(value,step){
  if(!Number.isFinite(value)||value<=0||(step!==1&&step!==-1))
    throw new RangeError("invalid positive Hz");
  const bytes=new DataView(new ArrayBuffer(8));
  bytes.setFloat64(0,value);
  bytes.setBigUint64(0,bytes.getBigUint64(0)+BigInt(step));
  return bytes.getFloat64(0);
}
export function audioFrequencyCap(sampleRate,railMax=20000){
  if(!Number.isFinite(sampleRate)||sampleRate<=0||
     !Number.isFinite(railMax)||railMax<=0)
    throw new RangeError("invalid sample rate or rail");
  return Math.min(railMax,nextPositive(sampleRate/2,-1));
}
export function reconcileFrequencyBounds({low,high,cap,changed="",min=0.001}){
  for(const [key,value] of Object.entries({low,high,cap,min}))
    if(!Number.isFinite(value))throw new RangeError(key+" must be finite");
  if(min<=0||cap<=min||nextPositive(min,1)>=cap)
    throw new RangeError("invalid frequency limits");
  const clamp=value=>Math.min(cap,Math.max(min,value));
  let L=clamp(low),H=clamp(high);
  if(L>=H){
    if(changed==="low"){
      if(L<cap)H=nextPositive(L,1);
      else {H=cap;L=nextPositive(cap,-1);}
    }else{
      if(H>min)L=nextPositive(H,-1);
      else {L=min;H=nextPositive(min,1);}
    }
  }
  return Object.freeze({low:L,high:H});
}
