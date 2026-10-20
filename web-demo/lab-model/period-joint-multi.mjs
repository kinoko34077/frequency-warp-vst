// #20 P2 research: several joint frequency-specific partials + preserved residual.
// This is a bounded *shared-sinusoid* model, not physical source separation.
// All observation windows fit the SAME oscillator unknowns for each candidate;
// no waveforms synthesized by different windows are mixed.
import {PERIOD_K,PERIOD_CYCLE_CHOICES,WINDOW_COUNT,theoreticalWindow,sampleInterval} from './period-joint.mjs';
import {detectClosePair} from './period-joint-close.mjs';
const TAU=2*Math.PI;
const MAX_PARTIALS=6;
function fft(re,im){
 const n=re.length;
 for(let i=1,j=0;i<n;i++){
  let bit=n>>1;while(j&bit){j^=bit;bit>>=1;}j^=bit;
  if(i<j){[re[i],re[j]]=[re[j],re[i]];[im[i],im[j]]=[im[j],im[i]];}
 }
 for(let size=2;size<=n;size*=2){
  const step=TAU/size;
  for(let start=0;start<n;start+=size){
   for(let j=0;j<size/2;j++){
    const angle=-step*j,wr=Math.cos(angle),wi=Math.sin(angle),k=start+j,p=k+size/2;
    const tr=re[p]*wr-im[p]*wi,ti=re[p]*wi+im[p]*wr;
    re[p]=re[k]-tr;im[p]=im[k]-ti;
    re[k]+=tr;im[k]+=ti;
   }
  }
 }
}
export function detectSharedCandidates(channels,sr,{maxCandidates=14}={}){
 // Take the strongest channel as guide, to avoid cancellation in antiphase stereo.
 const L=channels[0].length;
 let guide=channels[0],largest=-1;
 for(const ch of channels){
  let energy=0;for(let i=0;i<L;i+=8)energy+=ch[i]*ch[i];
  if(energy>largest){largest=energy;guide=ch;}
 }
 if(largest<1e-9)return [];
 let N=1024;
 while(N*2<=Math.min(L,16384))N*=2;
 const minHz=45,maxHz=Math.min(7500,sr*.44);
 const density=sr/N;
 const peaks=[];
 for(const center of [.23,.5,.77]){
  const start=Math.max(0,Math.min(L-N,Math.round(L*center-N/2)));
  const re=new Float64Array(N),im=new Float64Array(N);
  for(let i=0;i<N;i++)re[i]=guide[start+i]*(.5-.5*Math.cos(TAU*i/(N-1)));
  fft(re,im);
  const spectrum=new Float64Array(N/2);
  for(let k=0;k<N/2;k++)spectrum[k]=re[k]*re[k]+im[k]*im[k];
  const lo=Math.max(1,Math.ceil(minHz/density)),hi=Math.min(N/2-2,Math.floor(maxHz/density));
  for(let k=lo;k<=hi;k++){
   if(spectrum[k]<spectrum[k-1]||spectrum[k]<=spectrum[k+1])continue;
   const a=Math.log(spectrum[k-1]+1e-24),b=Math.log(spectrum[k]+1e-24),c=Math.log(spectrum[k+1]+1e-24);
   const offset=Math.max(-.5,Math.min(.5,.5*(a-c)/(a-2*b+c||1)));
   peaks.push({f:(k+offset)*density,power:spectrum[k]});
  }
 }
 peaks.sort((a,b)=>b.power-a.power);
 const chosen=[];
 for(const peak of peaks){
  if(chosen.every(v=>Math.abs(v.f-peak.f)>Math.max(density*1.15,3))){
   chosen.push(peak);
   if(chosen.length>=maxCandidates)break;
  }
 }
 return chosen.map(p=>({frequency:p.f,binHz:density,power:p.power}));
}
function observationFit(signal,sr,f,centers,K){
 let cc=0,cs=0,ss=0,yc=0,ys=0,energy=0;
 const half=theoreticalWindow(f,K)/2;
 for(const center of centers){
  const {firstSample,endSample}=sampleInterval(center,f,sr,K);
  for(let i=Math.max(0,firstSample);i<Math.min(signal.length,endSample);i++){
   const t=i/sr,position=(t-center)/half;
   if(Math.abs(position)>=1)continue;
   const w=.5+.5*Math.cos(Math.PI*position),p=TAU*f*t;
   const a=Math.cos(p),b=Math.sin(p),y=signal[i];
   cc+=w*a*a;cs+=w*a*b;ss+=w*b*b;yc+=w*y*a;ys+=w*y*b;energy+=w*y*y;
  }
 }
 const det=cc*ss-cs*cs;
 if(!(det>1e-8))return null;
 const a=(yc*ss-ys*cs)/det,b=(ys*cc-yc*cs)/det;
 return {a,b,score:Math.max(0,a*yc+b*ys),energy};
}
function scoreSource(signal,sr,f,params){
 // Independent full-segment consistency for a candidate inferred from
 // frequency-specific windows. Does not count overlapping windows as
 // independent physical measurements.
 let projection=0,energy=0,error=0;
 const stride=Math.max(1,Math.floor(sr/12000));
 for(let i=0;i<signal.length;i+=stride){
  const y=signal[i],p=TAU*f*i/sr;
  const predicted=params.a*Math.cos(p)+params.b*Math.sin(p);
  projection+=predicted*predicted;energy+=y*y;error+=(y-predicted)**2;
 }
 return {explained:energy>1e-12?Math.max(-1,1-error/energy):1,projection,energy};
}
function refine(signal,sr,centers,freq,binHz,K){
 let best=null;
 const test=f=>{
  if(f<45||f>Math.min(7500,sr*.44))return;
  const params=observationFit(signal,sr,f,centers,K);
  if(!params)return;
  const full=scoreSource(signal,sr,f,params);
  // Full waveform is a validation penalty, while source parameter
  // unknowns still come from ALL seven observation windows.
  const rating=full.explained;
  if(!best||rating>best.rating)best={frequency:f,params,rating,full};
 };
 const span=Math.min(14,Math.max(2,binHz*1.4)),coarseStep=Math.max(.25,span/12);
 for(let f=freq-span;f<=freq+span+.000001;f+=coarseStep)test(f);
 if(best){
  const at=best.frequency;
  for(let f=at-.45;f<=at+.451;f+=.05)test(f);
 }
 return best;
}
function addComponent(dest,component,sr,sign=1){
 const f=component.frequency;
 for(let c=0;c<dest.length;c++){
  const arr=dest[c],{a,b}=component.coefficients[c];
  if(!a&&!b)continue;
  const step=TAU*f/sr,cs=Math.cos(step),sn=Math.sin(step);
  let x=1,y=0;
  for(let i=0;i<arr.length;i++){
   arr[i]+=sign*temporalGain(component,i)*(a*x+b*y);
   const nextX=x*cs-y*sn;
   y=y*cs+x*sn;x=nextX;
   // Periodic exact re-anchor guards against drift over long chunks.
   if((i&4095)===4095){x=Math.cos(step*(i+1));y=Math.sin(step*(i+1));}
  }
 }
}
// All partials share the ORIGINAL SOURCE CLOCK. A frequency detected at the
// END of a 1.5s slice must not emit a full-length tone before its onset.
// The exact same time-varying component is subtracted from source PCM to form
// the residual, and rendered after the requested speed/pitch remapping.
export function temporalGain(partial,sourceFrame){
 const env=partial.envelope,hop=partial.envelopeHop;
 if(!env||!hop)return 1; // initial stationary fit, not an output shortcut
 const p=Math.max(0,Math.min(env.length-1,sourceFrame/hop));
 const i=Math.floor(p),fraction=p-i;
 return env[i]*(1-fraction)+env[Math.min(env.length-1,i+1)]*fraction;
}
function sourceSynchronousEnvelope(channels,sr,partials){
 const L=channels[0].length,count=partials.length;
 const step=Math.max(64,Math.round(sr*.01)),radius=Math.max(16,Math.round(sr*.027));
 // Evaluate all sinusoids against the ORIGINAL PCM, not against invented
 // globally active oscillators. Independent conditional subtraction made
 // near-degenerate candidate pairs mutually justify phantom pre-onsets.
 const basis=partials.map(partial=>{
  const cs=partial.coefficients;
  const dest=channels.map(()=>new Float32Array(L));
  const phase=TAU*partial.frequency/sr,co=Math.cos(phase),si=Math.sin(phase);
  let x=1,y=0;
  for(let i=0;i<L;i++){
   for(let c=0;c<channels.length;c++)dest[c][i]=cs[c].a*x+cs[c].b*y;
   const next=x*co-y*si;
   y=y*co+x*si;x=next;
   if((i&4095)===4095){x=Math.cos(phase*(i+1));y=Math.sin(phase*(i+1));}
  }
  return dest;
 });
 // Preserve the exact phase/amplitude of genuinely stationary multi-tone
 // material. Local low-rank fits cannot resolve 440/441Hz individually in
 // 54ms and would unnecessarily perturb a valid global shared model.
 // Use whole-source waveform fit as evidence: NO temporal compensation if
 // the stationary model already explains nearly all original PCM energy.
 let stationaryError=0,stationaryEnergy=0;
 for(let i=0;i<L;i+=Math.max(1,Math.floor(sr/12000))){
  for(let c=0;c<channels.length;c++){
   let prediction=0;
   for(let k=0;k<count;k++)prediction+=basis[k][c][i];
   const y=channels[c][i],error=y-prediction;
   stationaryError+=error*error;stationaryEnergy+=y*y;
  }
 }
 if(stationaryEnergy>1e-10&&stationaryError/stationaryEnergy<.012){
  for(const p of partials){p.envelope=null;p.envelopeHop=0;}
  return;
 }
 const envelopes=partials.map(()=>new Float32Array(Math.ceil(L/step)+1));
 const stride=Math.max(1,Math.floor(sr/16000));
 for(let j=0;j<envelopes[0].length;j++){
  const center=Math.min(L-1,j*step);
  const start=Math.max(0,center-radius),end=Math.min(L,center+radius+1);
  const gram=Array.from({length:count},()=>new Float64Array(count));
  const projection=new Float64Array(count),gain=new Float64Array(count);
  let signalEnergy=0;
  for(let i=start;i<end;i+=stride){
   for(let c=0;c<channels.length;c++){
    const y=channels[c][i];signalEnergy+=y*y;
    for(let k=0;k<count;k++){
     const a=basis[k][c][i];
     projection[k]+=a*y;
     for(let m=0;m<=k;m++)gram[k][m]+=a*basis[m][c][i];
    }
   }
  }
  if(signalEnergy>1e-12){
   for(let k=0;k<count;k++)for(let m=k+1;m<count;m++)gram[k][m]=gram[m][k];
   // Bounded nonnegative joint least squares with a gentle zero-gain prior.
   // A silent sample gives b=0 => ALL gains zero, including collinear tones.
   // It also allows a later note to enter while another source sustains.
   for(let sweep=0;sweep<20;sweep++){
    for(let k=0;k<count;k++){
     const regularizer=gram[k][k]*.025+1e-12;
     let rest=projection[k];
     for(let m=0;m<count;m++)if(m!==k)rest-=gram[k][m]*gain[m];
     gain[k]=Math.max(0,Math.min(1.5,rest/(gram[k][k]+regularizer)));
    }
   }
  }
  for(let k=0;k<count;k++){
   let g=gain[k];
   if(g<.07)g=0;
   envelopes[k][j]=g;
  }
 }
 for(let k=0;k<count;k++){
  partials[k].envelope=envelopes[k];
  partials[k].envelopeHop=step;
 }
}

// Precision guard for predominantly stationary slices: use the *original PCM*
// to refine all selected sinusoid frequencies continuously, then solve their
// stereo cos/sin coefficients TOGETHER. A discrete .05 Hz final search leaks
// the same audible carrier into the separately transformed residual.
function solveDense(matrix,rhs){
 const n=rhs.length,a=matrix.map((r,i)=>Float64Array.from([...r,rhs[i]]));
 let scale=0;for(let i=0;i<n;i++)scale=Math.max(scale,Math.abs(a[i][i]));
 if(!(scale>1e-14))return null;
 for(let i=0;i<n;i++)a[i][i]+=scale*1e-10;
 for(let i=0;i<n;i++){
  let pivot=i;
  for(let j=i+1;j<n;j++)if(Math.abs(a[j][i])>Math.abs(a[pivot][i]))pivot=j;
  if(Math.abs(a[pivot][i])<scale*1e-8)return null;
  [a[pivot],a[i]]=[a[i],a[pivot]];
  const d=a[i][i];for(let j=i;j<=n;j++)a[i][j]/=d;
  for(let j=0;j<n;j++)if(j!==i){
   const amount=a[j][i];for(let q=i;q<=n;q++)a[j][q]-=amount*a[i][q];
  }
 }
 return a.map(r=>r[n]);
}
function sourceJointFit(channels,sr,freqs,stride){
 const length=channels[0].length,dimension=freqs.length*2;
 const gram=Array.from({length:dimension},()=>new Float64Array(dimension));
 const targets=channels.map(()=>new Float64Array(dimension));
 const phases=freqs.map(f=>TAU*f/sr);
 const basis=new Float64Array(dimension);
 let energy=0;
 for(let i=0;i<length;i+=stride){
  for(let k=0;k<freqs.length;k++){
   const phase=phases[k]*i;
   basis[2*k]=Math.cos(phase);basis[2*k+1]=Math.sin(phase);
  }
  for(let c=0;c<channels.length;c++){
   const y=channels[c][i];energy+=y*y;
   for(let k=0;k<dimension;k++)targets[c][k]+=basis[k]*y;
  }
  for(let k=0;k<dimension;k++)for(let j=0;j<=k;j++)gram[k][j]+=basis[k]*basis[j];
 }
 for(let k=0;k<dimension;k++)for(let j=k+1;j<dimension;j++)gram[k][j]=gram[j][k];
 const coefficients=targets.map(t=>solveDense(gram,t));
 if(coefficients.some(v=>!v))return null;
 let error=energy;
 for(let c=0;c<channels.length;c++){
  for(let k=0;k<dimension;k++)error-=coefficients[c][k]*targets[c][k];
 }
 return {coefficients,error:Math.max(0,error),energy};
}
function refineOriginalWaveform(channels,sr,partials){
 const count=partials.length;
 if(count===0)return;
 // Limit full-file optimization work to bounded, high-confidence stationary
 // regions. Late attacks and modulated tones still use source-time NNLS.
 const stride=Math.max(1,Math.floor(sr/12000));
 const freqs=partials.map(p=>p.frequency);
 let current=sourceJointFit(channels,sr,freqs,stride);
 if(!current||current.energy<1e-10||current.error/current.energy>.075)return;
 const baseline=current;
 let best={...current,freqs:[...freqs]};
 // Joint least squares is linear in channel coefficients; each frequency
 // coordinate is continuously optimized conditional on all other oscillators.
 // Golden-section refinement is NOT another integer/sub-Hz quantization grid.
 for(let sweep=0;sweep<3;sweep++){
  for(let k=0;k<count;k++){
   const isolated=channels.map((ch,c)=>{
    const residual=new Float64Array(Math.ceil(ch.length/stride));
    const coeff=current.coefficients[c];
    for(let i=0,n=0;i<ch.length;i+=stride,n++){
     let other=0;
     for(let j=0;j<count;j++)if(j!==k){
      const phase=TAU*freqs[j]*i/sr;
      other+=coeff[2*j]*Math.cos(phase)+coeff[2*j+1]*Math.sin(phase);
     }
     residual[n]=ch[i]-other;
    }
    return residual;
   });
   const evaluate=f=>{
    let score=0;
    const w=TAU*f*stride/sr,cw=Math.cos(w),sw=Math.sin(w);
    for(const ch of isolated){
     let cc=0,ss=0,cs=0,cy=0,sy=0,x=1,y=0;
     for(let i=0;i<ch.length;i++){
      const z=ch[i];cc+=x*x;ss+=y*y;cs+=x*y;cy+=x*z;sy+=y*z;
      const xx=x*cw-y*sw;y=y*cw+x*sw;x=xx;
      if((i&2047)===2047){x=Math.cos(w*(i+1));y=Math.sin(w*(i+1));}
     }
     const d=cc*ss-cs*cs;
     if(d>1e-10)score+=(ss*cy*cy-2*cs*cy*sy+cc*sy*sy)/d;
    }
    return score;
   };
   let low=Math.max(45,freqs[k]-.105),high=Math.min(sr*.44,freqs[k]+.105);
   const phi=(Math.sqrt(5)-1)/2;
   let c=high-phi*(high-low),d=low+phi*(high-low);
   let fc=evaluate(c),fd=evaluate(d);
   for(let t=0;t<17;t++){
    if(fc>fd){high=d;d=c;fd=fc;c=high-phi*(high-low);fc=evaluate(c);}
    else {low=c;c=d;fc=fd;d=low+phi*(high-low);fd=evaluate(d);}
   }
   const candidate=(low+high)/2,old=freqs[k];
   freqs[k]=candidate;
   const trial=sourceJointFit(channels,sr,freqs,stride);
   if(!trial||trial.error>current.error+current.energy*1e-9){
    freqs[k]=old;
   }else current=trial;
  }
  if(current.error<best.error){best={...current,freqs:[...freqs]};}
 }
 if(best.error>baseline.error||!best.coefficients.every(x=>x.every(Number.isFinite)))return;
 for(let k=0;k<count;k++){
  const f=best.freqs[k];
  if(Math.abs(f-partials[k].frequency)>.32)continue;
  partials[k].frequency=f;
  partials[k].coefficients=best.coefficients.map(v=>({a:v[2*k],b:v[2*k+1]}));
 }
}
export function estimateSharedPartials({channels,sampleRate,K=PERIOD_K,maxPartials=MAX_PARTIALS}){
 if(!PERIOD_CYCLE_CHOICES.includes(K))throw RangeError('unsupported number of analysis cycles');
 if(!Array.isArray(channels)||channels.length<1||channels.length>2||!channels[0]?.length||
    channels.some(ch=>ch.length!==channels[0].length)||!Number.isFinite(sampleRate)||
    sampleRate<8000||sampleRate>192000)throw RangeError('invalid PCM for shared partial estimation');
 const L=channels[0].length;
 if(L>sampleRate*3)throw RangeError('joint processing chunks must be <=3s');
 if(!channels.every(ch=>ch.every(Number.isFinite)))throw RangeError('nonfinite PCM');
 const residual=channels.map(ch=>Float64Array.from(ch));
 const centers=Array.from({length:WINDOW_COUNT},(_,i)=>L/sampleRate*(i+.5)/WINDOW_COUNT);
 const candidates=detectSharedCandidates(channels,sampleRate,{maxCandidates:14});
 const partials=[];
 let baseEnergy=0;for(const ch of channels)for(let i=0;i<L;i+=4)baseEnergy+=ch[i]*ch[i];
 if(baseEnergy<1e-10)return {partials:[],residual,explained:1,windows:WINDOW_COUNT,candidates:0};
 // Resolve a bounded close-frequency hypothesis BEFORE greedy residual
 // peeling. FFT-bin peak de-dup can hide 440Hz + 441Hz as one source.
 // Do not force frequency fractions or align samples at disparate times.
 if(candidates.length){
  const close=detectClosePair({channels,sampleRate,peakFrequency:candidates[0].frequency});
  if(close){
   for(const p of close.partials){partials.push(p);addComponent(residual,p,sampleRate,-1);}
  }
 }
 for(const c of candidates){
  if(partials.length>=maxPartials)break;
  const guide=residual.reduce((best,ch)=>{
   let power=0;for(let i=0;i<L;i+=8)power+=ch[i]*ch[i];
   return !best||power>best.power?{ch,power}:best;
  },null).ch;
  const fit=refine(guide,sampleRate,centers,c.frequency,c.binHz,K);
  if(!fit||fit.rating<.008)continue;
  if(partials.some(p=>Math.abs(p.frequency-fit.frequency)<Math.max(.8,c.binHz*.2)))continue;
  const coefficients=residual.map(ch=>observationFit(ch,sampleRate,fit.frequency,centers,K)||{a:0,b:0});
  const partial={frequency:fit.frequency,coefficients,explainedInResidual:fit.rating};
  addComponent(residual,partial,sampleRate,-1);
  partials.push(partial);
 }
 // Block-coordinate joint refinement: refit each oscillator conditional on
 // all others. The final model uses ONE shared set of frequency/amplitudes.
 // Do not mix the synthetic outputs of any independent windows.
 for(const partial of partials){
  addComponent(residual,partial,sampleRate,1);
  const guide=residual[0];
  const updated=refine(guide,sampleRate,centers,partial.frequency,.4,K);
  if(updated&&updated.rating>=.005){
   partial.frequency=updated.frequency;
   partial.coefficients=residual.map(ch=>observationFit(ch,sampleRate,partial.frequency,centers,K)||{a:0,b:0});
  }
  addComponent(residual,partial,sampleRate,-1);
 }
 // Continuous multi-tone, multi-channel source-domain frequency/phase fit.
 refineOriginalWaveform(channels,sampleRate,partials);
 // Rebuild the complementary residual from the ORIGINAL input using the
 // SOURCE-TIME envelope for each partial. Subtracting the constant oscillator
 // here is the bug that made late notes sound up to one chunk early.
 if(partials.length){
  sourceSynchronousEnvelope(channels,sampleRate,partials);
  for(let c=0;c<channels.length;c++)residual[c].set(channels[c]);
  for(const partial of partials)addComponent(residual,partial,sampleRate,-1);
 }
 let residualEnergy=0;for(const ch of residual)for(let i=0;i<L;i+=4)residualEnergy+=ch[i]*ch[i];
 return {partials,residual,explained:Math.max(-1,1-residualEnergy/(baseEnergy+1e-12)),
   windows:WINDOW_COUNT,periodCycles:K,candidates:candidates.length,unresolvedPhysicalGrouping:true};
}
export function renderJointAudio({channels,sampleRate,speed=1,semitones=0,sourceStartSeconds=0,periodCycles=PERIOD_K,renderResidual}){
 if(!(Number.isFinite(speed)&&speed>=.5&&speed<=2&&Number.isFinite(semitones)&&semitones>=-12&&semitones<=12))throw RangeError('invalid transform');
 if(!(Number.isFinite(sourceStartSeconds)&&sourceStartSeconds>=0))throw RangeError('source offset');
 if(typeof renderResidual!=='function')throw TypeError('residual renderer is required');
 const frames=Math.max(1,Math.round(channels[0].length/speed));
 if(frames*channels.length>14_000_000)throw RangeError('memory cap');
 const model=estimateSharedPartials({channels,sampleRate,K:periodCycles});
 // For the neutral transform, retain the PCM exactly while still running
 // shared estimation. No transient or high-frequency signal is discarded.
 if(speed===1&&semitones===0)return {channels:channels.map(ch=>Float32Array.from(ch)),
  sampleRate,diagnostics:{partials:model.partials.length,residualEnergy:1-model.explained,periodCycles,neutral:true}};
 const transformedResidual=renderResidual(model.residual.map(ch=>Float32Array.from(ch)),frames);
 if(transformedResidual.length!==channels.length||transformedResidual.some(ch=>ch.length!==frames))throw RangeError('residual length mismatch');
 const out=transformedResidual.map(ch=>Float32Array.from(ch));
 const p=2**(semitones/12);
 for(const partial of model.partials){
  const f=partial.frequency,outF=f*p;
  // The original source coefficients a,b are defined at *chunk-local*
  // source time zero. At absolute output time sourceStart/speed the correctly
  // transported phase difference is 2pi*(outF/speed-f)*sourceStart.
  // Reduce cycles BEFORE cosine rather than cancel two million-cycle angles.
  // Source residual subtraction and pitched re-synthesis share the same
  // a*cos(theta)+b*sin(theta) basis; stereo channels share EXACT phase clock.
  const cycles=(outF/speed-f)*sourceStartSeconds;
  const phase=TAU*(cycles-Math.round(cycles));
  const step=TAU*outF/sampleRate,cosStep=Math.cos(step),sinStep=Math.sin(step);
  let x=Math.cos(phase),y=Math.sin(phase);
  for(let i=0;i<frames;i++){
   const g=temporalGain(partial,i*speed);
   for(let c=0;c<out.length;c++){
    const {a,b}=partial.coefficients[c];
    out[c][i]+=g*(a*x+b*y);
   }
   const xx=x*cosStep-y*sinStep;
   y=y*cosStep+x*sinStep;x=xx;
   if((i&4095)===4095){
    const exact=phase+step*(i+1);
    x=Math.cos(exact);y=Math.sin(exact);
   }
  }
 }
 // Output never silently drops the unmodeled content; artifacts remain possible.
 for(const ch of out)for(let i=0;i<ch.length;i++)if(!Number.isFinite(ch[i]))throw RangeError('nonfinite rendered PCM');
 return {channels:out,sampleRate,diagnostics:{partials:model.partials.length,
   residualEnergy:Math.max(0,1-model.explained),periodCycles,candidates:model.candidates,grouping:'ambiguous'}};
}
