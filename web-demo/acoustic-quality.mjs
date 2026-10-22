/** #299 Objective acoustic diagnostics, deliberately independent of DSP.
 * One number must not masquerade as human-perceived music quality.
 * Reference-waveform metrics apply ONLY to actual identity/known-waveform
 * tasks, not to a deliberately warped target with non-unique phase.
 */
const tiny=1e-24;
const valid=(x)=>Number.isFinite(x);
function verifyPair(input,output,start,end){
  if(!input||!output||input.length!==output.length||!Number.isInteger(start)||
     !Number.isInteger(end)||start<0||end>input.length||end<=start)
    throw new RangeError("matched nonempty channels and valid measured window required");
  for(let i=start;i<end;i++)if(!valid(input[i])||!valid(output[i]))
    throw new RangeError("non-finite audio in measurement window");
}
const rms=(sum,n)=>Math.sqrt(sum/n);
const db=(ratio)=>20*Math.log10(Math.max(tiny,ratio));
export function fullReferenceQuality(input,output,{start=0,end=input.length,blockSize=256}={}){
  verifyPair(input,output,start,end);
  if(!Number.isInteger(blockSize)||blockSize<=0)throw new RangeError("bad blockSize");
  let source=0,actual=0,err=0,cross=0,clip=0;
  const sourceBlocks=[],actualBlocks=[];
  for(let k=start;k<end;k+=blockSize){
    let x2=0,y2=0;
    for(let i=k;i<Math.min(end,k+blockSize);i++){
      const x=input[i],y=output[i];
      x2+=x*x;y2+=y*y;err+=(x-y)**2;cross+=x*y;
      if(Math.abs(y)>1)clip++;
    }
    const n=Math.min(end,k+blockSize)-k;
    source+=x2;actual+=y2;
    sourceBlocks.push(rms(x2,n));actualBlocks.push(rms(y2,n));
  }
  // A zero reference is not evidence that a silent algorithm sounds good.
  if(source<=tiny)throw new RangeError("silent reference: fidelity score undefined");
  const ratio=Math.sqrt(actual/source);
  const variation=blocks=>{
    const avg=blocks.reduce((a,b)=>a+b,0)/blocks.length;
    return avg<=tiny?null:Math.sqrt(blocks.reduce((a,b)=>a+(b-avg)**2,0)/blocks.length)/avg;
  };
  return {
    referenceClass:"exact-waveform",
    samples:end-start,
    referenceRms:rms(source,end-start),
    outputRms:rms(actual,end-start),
    gainDb:db(ratio),
    rmsGain:ratio,
    nrmse:Math.sqrt(err/source),
    correlation:actual<=tiny?null:Math.max(-1,Math.min(1,cross/Math.sqrt(source*actual))),
    clippedSamples:clip,
    sourceBlockRmsCV:variation(sourceBlocks),
    outputBlockRmsCV:variation(actualBlocks),
    lostPowerFraction:1-actual/source,
    outputSilent:actual<=source*1e-12
  };
}
function channelStats(left,right,start,end){
  verifyPair(left,right,start,end);
  let l2=0,r2=0,cross=0,side=0,mid=0;
  for(let i=start;i<end;i++){
    const l=left[i],r=right[i],m=(l+r)*.5,s=(l-r)*.5;
    l2+=l*l;r2+=r*r;cross+=l*r;side+=s*s;mid+=m*m;
  }
  if(l2<=tiny||r2<=tiny)throw new RangeError("silent channel: stereo geometry undefined");
  return {ildDb:db(Math.sqrt(r2/l2)),lrCorrelation:cross/Math.sqrt(l2*r2),
    sideToMidRatio:Math.sqrt(side/Math.max(tiny,mid)),sidePower:side,midPower:mid};
}
export function stereoImageQuality(inputL,inputR,outputL,outputR,
  {start=0,end=inputL.length}={}){
  if(inputL.length!==inputR.length||inputL.length!==outputL.length||
    inputL.length!==outputR.length)throw new RangeError("mismatched channels");
  const source=channelStats(inputL,inputR,start,end);
  const output=channelStats(outputL,outputR,start,end);
  return {referenceClass:"defined-stereo",
    ildErrorDb:output.ildDb-source.ildDb,
    correlationDelta:output.lrCorrelation-source.lrCorrelation,
    sideEnergyRatio:output.sidePower/Math.max(tiny,source.sidePower),
    source,output};
}
/** Known-envelope transient diagnostics. A gated source supplies only
 * expected onset/end times, NOT a unique warped waveform. Measure leakage
 * in the preceding/following windows and a 32-sample short-time RMS onset.
 * For aligned offline PCM the expected onset is the original source onset;
 * real-time stream callers MUST supply/declare their latency separately.
 */
export function transientEnvelopeQuality(signal,{
  sampleRate,onsetSample,endSample,windowMs=70,rmsWindow=32,
  rmsHop=8,thresholdRatio=.22
}={}){
  if(!signal||!valid(sampleRate)||sampleRate<=0||
    !Number.isInteger(onsetSample)||!Number.isInteger(endSample)||
    !(0<onsetSample&&onsetSample<endSample&&endSample<signal.length)||
    !valid(windowMs)||windowMs<=0||!Number.isInteger(rmsWindow)||
    rmsWindow<2||!Number.isInteger(rmsHop)||rmsHop<1||
    !valid(thresholdRatio)||thresholdRatio<=0||thresholdRatio>=1)
    throw new RangeError("invalid known-envelope transient timing");
  const span=Math.max(rmsWindow,Math.round(sampleRate*windowMs/1000));
  const first=Math.max(0,onsetSample-span),last=Math.min(signal.length,endSample+span);
  const energy=(begin,end)=>{
    let square=0;
    for(let i=begin;i<end;i++){
      const x=signal[i];
      if(!valid(x))throw new RangeError("nonfinite transient PCM");
      square+=x*x;
    }
    return square;
  };
  const before=energy(first,onsetSample),active=energy(onsetSample,endSample),
    after=energy(endSample,last);
  const preRms=rms(before,onsetSample-first),
    activeRms=rms(active,endSample-onsetSample),
    tailRms=rms(after,last-endSample);
  if(active<=tiny)return {
    referenceClass:"known-envelope",outputSilent:true,onsetOffsetSamples:null,
    preToActiveDb:null,tailToActiveDb:null,activeRms:0,preRms,tailRms,
    declaredAlignmentSamples:0
  };
  const threshold=thresholdRatio*activeRms;
  let firstCrossing=null;
  const stop=Math.min(endSample,signal.length-rmsWindow);
  for(let i=Math.max(0,first);i<=stop;i+=rmsHop){
    const level=rms(energy(i,i+rmsWindow),rmsWindow);
    if(level>=threshold){firstCrossing=i;break;}
  }
  return {
    referenceClass:"known-envelope",outputSilent:false,
    onsetOffsetSamples:firstCrossing===null?null:firstCrossing-onsetSample,
    preToActiveDb:db(preRms/activeRms),
    tailToActiveDb:db(tailRms/activeRms),
    activeRms,preRms,tailRms,
    declaredAlignmentSamples:0
  };
}
/** Lock-in projection is a *diagnostic* at specified frequencies. It is not
 * a general pitch estimator, and can be contaminated by off-bin leakage.
 */
export function toneComponentQuality(signal,{sampleRate,targetHz,sourceHz=null,
  start=0,end=signal.length}={}){
  if(!valid(sampleRate)||sampleRate<=0||!valid(targetHz)||targetHz<=0||
    !Number.isInteger(start)||!Number.isInteger(end)||start<0||end-start<2||
    targetHz>=sampleRate/2||end<=start||end>signal.length)
    throw new RangeError("invalid tone oracle");
  if(sourceHz!==null&&(!valid(sourceHz)||sourceHz<=0||sourceHz>=sampleRate/2))
    throw new RangeError("invalid source tone");
  const measure=hz=>{
    let cosine=0,sine=0;
    for(let i=start;i<end;i++){
      const value=signal[i];if(!valid(value))throw new RangeError("nonfinite tone");
      // Hann taper limits nearest-bin leakage; frequency is continuous Hz.
      const w=(1-Math.cos(2*Math.PI*(i-start)/(end-start-1)))*.5;
      const phi=2*Math.PI*hz*i/sampleRate;
      cosine+=value*w*Math.cos(phi);sine+=value*w*Math.sin(phi);
    }
    return 4*Math.hypot(cosine,sine)/(end-start-1);
  };
  const desired=measure(targetHz);
  const old=sourceHz===null?null:measure(sourceHz);
  return {referenceClass:"known-frequency",
    targetHz,targetAmplitude:desired,
    sourceHz,sourceGhostAmplitude:old,
    ghostToTargetDb:old===null?null:db(old/Math.max(tiny,desired))};
}
export function qualityGate(measurement,criteria){
  if(!measurement||!criteria||Array.isArray(criteria)||
    typeof criteria!=="object")throw new TypeError("invalid evaluation contract");
  const failures=[];
  for(const [name,{max,min}] of Object.entries(criteria)){
    if(!Object.prototype.hasOwnProperty.call(measurement,name))
      throw new RangeError("unknown metric "+name);
    const value=measurement[name];
    if(!valid(value)){failures.push(name+": missing/nonfinite evidence");continue;}
    if(max!==undefined&&value>max)failures.push(name+": "+value+" > "+max);
    if(min!==undefined&&value<min)failures.push(name+": "+value+" < "+min);
  }
  return {pass:failures.length===0,failures};
}
/** A severity check is required even without a human MOS label. Do not
 * fit thresholds to A's failure; calibrate a desired neutral contract using
 * positive/negative controls and explicitly retain known product failures.
 */
export const baselineNeutralContract=Object.freeze({
  nrmse:{max:.08},
  rmsGain:{min:.93,max:1.07},
  clippedSamples:{max:0},
  correlation:{min:.995}
});
