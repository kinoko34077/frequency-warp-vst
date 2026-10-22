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

/** #305 Known gated-onset oracle for an intentionally *frequency-warped*
 * source. Deliberately compares envelope/timing, not dry PCM samples.
 * Output is the *already latency-compensated* WAV; caller must report
 * processor latency separately if running live blocks.
 */
export function transientOnsetQuality(reference,rendered,{
  sampleRate,onsetSample,preSamples=512,attackSamples=512,
  blockSamples=16,onsetThreshold=0.15
}={}){
  if(!valid(sampleRate)||sampleRate<=0||
    !Number.isInteger(onsetSample)||!Number.isInteger(preSamples)||
    !Number.isInteger(attackSamples)||!Number.isInteger(blockSamples)||
    onsetSample<preSamples||preSamples<=0||attackSamples<=0||
    blockSamples<=0||!valid(onsetThreshold)||onsetThreshold<=0||
    onsetThreshold>=1||onsetSample+attackSamples>reference.length)
    throw new RangeError("invalid gated onset window or parameters");
  const start=onsetSample-preSamples,end=onsetSample+attackSamples;
  verifyPair(reference,rendered,start,end);
  const power=(signal,a,b)=>{
    let total=0;
    for(let i=a;i<b;i++)total+=signal[i]*signal[i];
    return total/(b-a);
  };
  const refPre=power(reference,start,onsetSample);
  const refAttack=power(reference,onsetSample,end);
  if(refAttack<1e-12)
    throw new RangeError("silent source attack: onset oracle undefined");
  if(refPre>refAttack*1e-10)
    throw new RangeError("source before declared onset is not silent");
  const outPre=power(rendered,start,onsetSample);
  const outAttack=power(rendered,onsetSample,end);
  const ratio=Math.sqrt(outAttack/refAttack);
  const active=outAttack>refAttack*1e-12;
  const detectFloor=Math.sqrt(refAttack)*onsetThreshold;
  let detected=null;
  // Detect first sustained short-block energy at an actual sample. The
  // onsets are quantized by blockSamples; do not infer exact perceptual
  // onset from the non-overlapping energy proxy.
  for(let i=start;i+blockSamples<=end;i+=blockSamples){
    if(Math.sqrt(power(rendered,i,i+blockSamples))>=detectFloor){
      detected=i;break;
    }
  }
  return {
    referenceClass:"known-gated-onset",
    sampleRate,onsetSample,blockSamples,preSamples,attackSamples,
    referenceAttackRms:Math.sqrt(refAttack),
    outputAttackRms:Math.sqrt(outAttack),
    attackRmsRatio:ratio,
    preEchoDb:active?10*Math.log10(Math.max(tiny,outPre)/outAttack):null,
    onsetOffsetMs:detected===null?null:(detected-onsetSample)*1000/sampleRate,
    onsetDetected:detected!==null,
    // The algorithm cannot distinguish intentional spatial predelay,
    // ringing and spectral pre-echo. Diagnose, do not invent causality.
    caveat:"Short-block energy proxy; known gated source and latency-compensated output only"
  };
}
