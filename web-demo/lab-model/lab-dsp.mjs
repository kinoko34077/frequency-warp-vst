import {renderPeriodJointTone} from './period-joint.mjs';
import {renderJointAudio} from './period-joint-multi.mjs';
// Offline DSP model comparison. All audio stays in-browser.
export const MODELS=[
{id:'pv',label:'Phase Vocoder',description:'STFT phase propagation'},
{id:'wsola',label:'WSOLA',description:'Waveform-similarity overlap-add'},
{id:'dual',label:'Dual-window Onset Blend',description:'Experimental short/long STFT onset-directed output fusion'},
{id:'am',label:'AM Envelope × Phase Vocoder',description:'Experimental envelope-separated PV; not source identification'},
{id:'period-joint',label:'Frequency-specific Joint Period (experimental)',description:'Issue #20 opt-in multi-partial joint estimator with source-time gain and residual; physical grouping is not identified'}
];
const TAU=Math.PI*2,clamp=(x,a,b)=>Math.max(a,Math.min(b,x)),fit=(a,n)=>{let b=new Float32Array(n);b.set(a.subarray(0,n));return b};
function fft(re,im,inv=false){let n=re.length;for(let i=1,j=0;i<n;i++){let bit=n>>1;for(;j&bit;bit>>=1)j^=bit;j^=bit;if(i<j){[re[i],re[j]]=[re[j],re[i]];[im[i],im[j]]=[im[j],im[i]];}}for(let len=2;len<=n;len*=2){let wr0=Math.cos(TAU/len),wi0=Math.sin((inv?1:-1)*TAU/len);for(let i=0;i<n;i+=len){let wr=1,wi=0;for(let j=0;j<len/2;j++){let u=i+j,v=u+len/2,a=re[v]*wr-im[v]*wi,b=re[v]*wi+im[v]*wr;re[v]=re[u]-a;im[v]=im[u]-b;re[u]+=a;im[u]+=b;let nw=wr*wr0-wi*wi0;wi=wr*wi0+wi*wr0;wr=nw;}}}if(inv)for(let i=0;i<n;i++){re[i]/=n;im[i]/=n;}}
const hann=n=>Float64Array.from({length:n},(_,i)=>.5-.5*Math.cos(TAU*(i+.5)/n));
// Bandlimited pitch-resampling avoids the frequency folding introduced by
// straight line interpolation, particularly for upward pitch shifts.
// Lanczos-windowed sinc, 8 source samples either side; bounded work per chunk.
export function resampleBandlimited(input,factor){
 if(Math.abs(factor-1)<1e-12)return Float32Array.from(input);
 if(!(Number.isFinite(factor)&&factor>0))throw RangeError('invalid pitch factor');
 const len=Math.max(1,Math.round(input.length/factor)),out=new Float32Array(len);
 const radius=8,cutoff=Math.min(1,1/factor);
 const sinc=x=>Math.abs(x)<1e-9?1:Math.sin(Math.PI*x)/(Math.PI*x);
 for(let i=0;i<len;i++){
  const x=i*factor,mid=Math.floor(x);
  let sum=0,weight=0;
  for(let j=mid-radius+1;j<=mid+radius;j++){
   const dist=x-j,window=sinc(dist/radius);
   const w=cutoff*sinc(dist*cutoff)*window;
   if(j>=0&&j<input.length){sum+=input[j]*w;weight+=w;}
  }
  out[i]=weight?sum/weight:0;
 }
 return out;
}
export function resampleLinear(input,factor){if(Math.abs(factor-1)<1e-12)return Float32Array.from(input);let n=Math.max(1,Math.round(input.length/factor)),out=new Float32Array(n);for(let i=0;i<n;i++){let x=Math.min(input.length-1,i*factor),p=Math.floor(x),a=x-p;out[i]=(input[p]||0)*(1-a)+(input[Math.min(input.length-1,p+1)]||0)*a;}return out;}
// Peak-locked phase vocoder (Laroche–Dolson identity phase locking).
// A shared spectral phase guide retains interchannel relative phase; this
// is not source separation and cannot restore information absent in PCM.
const wrapPhase=p=>p-TAU*Math.round(p/TAU);
export function phaseVocoder(channels,stretch,outLen,fftSize=2048){
 if(Math.abs(stretch-1)<1e-8)return channels.map(x=>fit(x,outLen));
 const N=fftSize??2048,half=N/2,Hs=N/4,w=hann(N),L=channels[0].length;
 const result=channels.map(()=>new Float64Array(outLen+N+Hs));
 const norm=new Float64Array(outLen+N+Hs),prePhase=new Float64Array(half+1);
 const phaseAcc=new Float64Array(half+1),prevMag=new Float64Array(half+1);
 const phi=new Float64Array(half+1),guideMag=new Float64Array(half+1);
 const synthPhase=new Float64Array(half+1),peaks=new Int32Array(half+1);
 const specs=channels.map(()=>({re:new Float64Array(N),im:new Float64Array(N)}));
 let prevSrc=0,first=true;
 for(let pos=0;pos<outLen+N;pos+=Hs){
  const src=Math.round(pos/stretch),hop=first?0:Math.max(1,src-prevSrc);
  prevSrc=src;
  // Both channels share the same analysis-frame alignment.
  for(let c=0;c<channels.length;c++){
   const {re,im}=specs[c],input=channels[c];
   for(let j=0;j<N;j++){re[j]=(input[src+j]||0)*w[j];im[j]=0;}
   fft(re,im);
  }
  let positiveFlux=0,previousEnergy=0,currentEnergy=0,maxMag=0;
  for(let k=0;k<=half;k++){
   let sumRe=0,sumIm=0,best=0,bestRe=0,bestIm=0,magnitude=0;
   for(const {re,im} of specs){
    const m=Math.hypot(re[k],im[k]);
    magnitude+=m;sumRe+=re[k];sumIm+=im[k];
    if(m>best){best=m;bestRe=re[k];bestIm=im[k];}
   }
   // Avoid a zero guide for antiphase stereo; retain channel differences.
   if(Math.hypot(sumRe,sumIm)<magnitude*.03){sumRe=bestRe;sumIm=bestIm;}
   phi[k]=Math.atan2(sumIm,sumRe);guideMag[k]=magnitude/channels.length;
   positiveFlux+=Math.max(0,guideMag[k]-prevMag[k]);
   previousEnergy+=prevMag[k];currentEnergy+=guideMag[k];
   prevMag[k]=guideMag[k];maxMag=Math.max(maxMag,guideMag[k]);
  }
  const transient=!first&&currentEnergy>0.015&&
    positiveFlux/(previousEnergy+1e-9)>.58&&currentEnergy>previousEnergy*1.2;
  // Track ALL bins before selecting peaks. A peak may move between FFT
  // bins from frame to frame; updating only previous peak indices makes the
  // phase of newly appearing peaks jump arbitrarily.
  for(let k=0;k<=half;k++){
   const expect=TAU*k*hop/N;
   const delta=first?0:wrapPhase(phi[k]-prePhase[k]-expect);
   if(first||transient)phaseAcc[k]=phi[k];
   else phaseAcc[k]+=TAU*k*Hs/N+delta*Hs/hop;
  }
  let count=0;
  for(let k=1;k<half;k++)if(guideMag[k]>=guideMag[k-1]&&
    guideMag[k]>=guideMag[k+1]&&guideMag[k]>maxMag*.004)peaks[count++]=k;
  if(count===0)peaks[count++]=Math.max(0,guideMag.indexOf(maxMag));
  for(let k=0,j=0;k<=half;k++){
   while(j+1<count&&Math.abs(peaks[j+1]-k)<Math.abs(peaks[j]-k))j++;
   const center=peaks[j];
   synthPhase[k]=phaseAcc[center]+wrapPhase(phi[k]-phi[center]);
  }
  for(let k=0;k<=half;k++)prePhase[k]=phi[k];
  for(let c=0;c<channels.length;c++){
   const {re,im}=specs[c];
   for(let k=0;k<=half;k++){
    const relative=wrapPhase(Math.atan2(im[k],re[k])-phi[k]);
    const phase=synthPhase[k]+relative,mag=Math.hypot(re[k],im[k]);
    re[k]=mag*Math.cos(phase);im[k]=mag*Math.sin(phase);
   }
   for(let k=1;k<half;k++){re[N-k]=re[k];im[N-k]=-im[k];}
   im[0]=0;im[half]=0;fft(re,im,true);
   const dest=result[c];
   for(let j=0;j<N&&pos+j<dest.length;j++)dest[pos+j]+=re[j]*w[j];
  }
  for(let j=0;j<N&&pos+j<norm.length;j++)norm[pos+j]+=w[j]*w[j];
  first=false;
 }
 return result.map(ch=>Float32Array.from({length:outLen},(_,i)=>
   norm[i]>1e-5?ch[i]/norm[i]:0));
}
// WSOLA: find each next waveform grain at sample precision around its
// expected source-time position, then overlap-add. Both stereo channels share
// one candidate offset to avoid relative-phase changes.
// Short-grain WSOLA with longer matching evidence and bounded trajectory.
// IMPORTANT: `fftSize` remains the *actual synthesis window* (including 256).
// The extra reference is evidence for finding a splice, not a silent clamp
// of the user's window size. All channels use the same source offset.
export function wsola(channels,stretch,outLen,fftSize=1024,sampleRate=48000){
 if(Math.abs(stretch-1)<1e-8)return channels.map(x=>fit(x,outLen));
 const L=channels[0].length,N=Math.min(fftSize,Math.max(256,Math.floor(L/2)));
 const hop=Math.max(32,N/4),overlap=N-hop,w=hann(N);
 // WSOLA must preserve each grain's native phase/frequency: the *natural*
 // next source position is prev+hop, NOT prev+hop/stretch. Time scaling
 // emerges through phase-coherent repeats/skips when the absolute desired
 // source position diverges. Short windows need >=1 low-bass period search.
 const search=Math.max(256,Math.min(2048,Math.round(sampleRate*.022)));
 const reference=Math.max(overlap,Math.min(Math.round(sampleRate*.028),Math.max(N*3,overlap)));
 const output=channels.map(()=>new Float64Array(outLen+N));
 const weight=new Float64Array(outLen+N);
 let prev=-1;
 function comparison(candidate,expected,natural,limit,step){
  const refFrom=prev+hop;
  if(refFrom>=L||candidate>=L)return -Infinity;
  const available=Math.min(limit,L-refFrom,L-candidate);
  if(available<overlap/2)return -Infinity;
  let overlapDot=0,overlapA=0,overlapB=0,refDot=0,refA=0,refB=0;
  for(let j=0;j<available;j+=step){
   for(let c=0;c<channels.length;c++){
    const ch=channels[c],x=ch[refFrom+j],y=ch[candidate+j];
    if(j<overlap){
      overlapDot+=x*y;overlapA+=x*x;overlapB+=y*y;
    }
    refDot+=x*y;refA+=x*x;refB+=y*y;
   }
  }
  const overlapPower=Math.sqrt(overlapA*overlapB),refPower=Math.sqrt(refA*refB);
  if(overlapPower<1e-11||refPower<1e-11){
    return -.15*Math.abs(candidate-expected)/search;
  }
  // Both local splice similarity and a longer low-frequency reference must
  // agree, but nearby repeated cycles must not cause large time-map jumps.
  const overlapScore=overlapDot/(overlapPower+1e-12);
  const longScore=refDot/(refPower+1e-12);
  const expectedError=Math.abs(candidate-expected)/search;
  const branchJump=Math.abs(candidate-natural)/search;
  // Select the strongest phase-compatible candidate NEAR the time map;
  // natural evolution or a whole-period jump both maintain acoustic pitch.
  return .58*overlapScore+.42*longScore-.34*expectedError-.025*branchJump;
 }
 for(let pos=0;pos<outLen;pos+=hop){
  const ideal=Math.max(0,Math.min(L-N,Math.round(pos/stretch)));
  let src=ideal;
  if(prev>=0&&ideal<L-N){
   const natural=Math.max(0,Math.min(L-N,prev+hop));
   const lo=Math.max(0,ideal-search),hi=Math.min(L-N,ideal+search);
   let best=-Infinity,bestSrc=ideal;
   // Seed both the ideal timeline and unmodified audio progression.
   for(const candidate of [ideal,natural]){
    if(candidate<lo||candidate>hi)continue;
    const score=comparison(candidate,ideal,natural,reference,8);
    if(score>best){best=score;bestSrc=candidate;}
   }
   for(let candidate=lo;candidate<=hi;candidate+=16){
    const score=comparison(candidate,ideal,natural,reference,16);
    if(score>best){best=score;bestSrc=candidate;}
   }
   const bestCoarse=bestSrc;
   for(let candidate=Math.max(lo,bestCoarse-16);candidate<=Math.min(hi,bestCoarse+16);candidate++){
    const score=comparison(candidate,ideal,natural,reference,4);
    if(score>best){best=score;bestSrc=candidate;}
   }
   src=bestSrc;
  }
  for(let j=0;j<N&&pos+j<weight.length;j++){
   const wi=w[j],index=pos+j;
   weight[index]+=wi;
   for(let c=0;c<channels.length;c++)output[c][index]+=(channels[c][src+j]||0)*wi;
  }
  prev=src;
 }
 return output.map(ch=>Float32Array.from({length:outLen},(_,i)=>
   weight[i]>1e-5?ch[i]/weight[i]:0));
}
// Dual-resolution onset processing. Long window stabilizes sustained
// partials; short window anchors transient timing. The signals are locally
// time-aligned before equal-power switching to avoid blind opposite-phase mix.
export function dualWindowVocoder(channels,stretch,len,sr,longSize=2048,shortSize=512){
 if(Math.abs(stretch-1)<1e-8)return channels.map(x=>fit(x,len));
 if(!(shortSize<longSize))throw RangeError('短窓は長窓より短くしてください');
 const long=phaseVocoder(channels,stretch,len,longSize);
 const short=phaseVocoder(channels,stretch,len,shortSize);
 const weights=new Float32Array(len),hop=Math.max(64,shortSize/4);
 const span=Math.max(192,shortSize),L=channels[0].length;
 let previous=0;
 for(let i=0;i<L;i+=hop){
  let power=0,count=0;
  for(let j=i;j<Math.min(L,i+hop);j++){
   for(const ch of channels)power+=(ch[j]||0)**2;
   count+=channels.length;
  }
  const rms=Math.sqrt(power/Math.max(1,count));
  if(rms>previous*2.15+.009){
   const center=Math.round(i*stretch);
   for(let j=Math.max(0,center-span);j<Math.min(len,center+span);j++){
    const w=Math.max(0,1-Math.abs(j-center)/span);
    weights[j]=Math.max(weights[j],w);
   }
  }
  previous=previous*.82+rms*.18;
 }
 // Correlation-guided short-window alignment at each strong onset (shared
 // stereo delay) limits cancellation when two independent vocoders disagree.
 const anchors=[];
 let last=-shortSize;
 for(let i=1;i<len-1;i++)if(weights[i]>.95&&weights[i]>=weights[i-1]&&weights[i]>=weights[i+1]&&i-last>=shortSize/2){
  last=i;
  const search=Math.max(2,Math.min(32,Math.round(sr*.0007)));
  let bestLag=0,best=-Infinity;
  for(let lag=-search;lag<=search;lag++){
   let dot=0,aa=0,bb=0;
   for(let j=-Math.round(shortSize/3);j<=Math.round(shortSize/3);j+=5){
    const x=i+j,y=x+lag;
    if(x<0||x>=len||y<0||y>=len)continue;
    for(let c=0;c<channels.length;c++){
     const a=long[c][x],b=short[c][y];
     dot+=a*b;aa+=a*a;bb+=b*b;
    }
   }
   const score=dot/(Math.sqrt(aa*bb)+1e-9);
   if(score>best){best=score;bestLag=lag;}
  }
  anchors.push({at:i,lag:bestLag});
 }
 const out=long.map(ch=>new Float32Array(ch));
 for(let i=0,anchor=0;i<len;i++){
  const weight=weights[i];if(weight<=0)continue;
  while(anchor+1<anchors.length&&Math.abs(anchors[anchor+1].at-i)<Math.abs(anchors[anchor].at-i))anchor++;
  const lag=anchors[anchor]&&Math.abs(anchors[anchor].at-i)<=span?anchors[anchor].lag:0;
  const w=Math.sin(weight*Math.PI/2)**2;
  for(let c=0;c<channels.length;c++){
   const j=Math.max(0,Math.min(len-1,i+lag));
   out[c][i]=long[c][i]*(1-w)+short[c][j]*w;
  }
 }
 return out;
}
function envelope(channels,sr){let tau=1-Math.exp(-1/(sr*.012)),out=new Float32Array(channels[0].length),p=0;for(let i=0;i<out.length;i++){let sq=0;for(let ch of channels)sq+=(ch[i]||0)**2;p+=(sq/channels.length-p)*tau;out[i]=Math.sqrt(p+1e-8);}let q=out[out.length-1]||0;for(let i=out.length-1;i>=0;i--){q+=(out[i]-q)*tau;out[i]=Math.max(out[i],q);}return out;}
// Preserve *slow* amplitude contours without multiplying a phase-vocoder
// carrier by the reciprocal of near-silent RMS (the former AM path magnified
// floor noise and introduced periodic, comb-like modulation).
// A gently smoothed gain envelope makes no new independently delayed copy.
export function amVocoder(channels,stretch,len,sr,fftSize=2048){
 if(Math.abs(stretch-1)<1e-8)return channels.map(x=>fit(x,len));
 const processed=phaseVocoder(channels,stretch,len,fftSize);
 const original=envelope(channels,sr),actual=envelope(processed,sr);
 const target=resampleLinear(original,original.length/len);
 const corrected=processed.map(()=>new Float32Array(len));
 const alpha=1-Math.exp(-1/(sr*.035));
 let smoothed=1;
 for(let i=0;i<len;i++){
  // In quiet areas skip near-zero RMS ratios altogether to avoid pumping.
  const wanted=target[i]<.004?1:clamp(target[i]/Math.max(.004,actual[i]),.72,1.28);
  smoothed+=alpha*(wanted-smoothed);
  for(let c=0;c<channels.length;c++)corrected[c][i]=processed[c][i]*smoothed;
 }
 return corrected;
}
export function renderPCM({channels,sampleRate,speed=1,semitones=0,model='pv',fftSize=2048,shortFftSize=512,longFftSize=fftSize,sourceStartSeconds=0,periodCycles=8,jointBackend=null}){if(!Array.isArray(channels)||!channels.length||channels.length>2||!channels[0]?.length)throw Error('有効なモノラル／ステレオ音声が必要です');if(!channels.every(x=>x.length===channels[0].length))throw Error('チャンネル長が一致しません');if(!Number.isFinite(sampleRate)||sampleRate<8000||sampleRate>192000)throw Error('非対応サンプリング周波数です');if(!Number.isFinite(speed)||speed<.5||speed>2||!Number.isFinite(semitones)||semitones<-12||semitones>12)throw Error('範囲外パラメータです');if(!MODELS.some(m=>m.id===model))throw Error('未知の解析モデルです');if(![1024,2048,4096,8192].includes(longFftSize)||![256,512,1024,2048].includes(shortFftSize)||(model==='dual'&&shortFftSize>=longFftSize))throw Error('短窓・長窓の設定が不正です');if(![1024,2048,4096].includes(fftSize))throw Error('窓長は1024/2048/4096サンプルにしてください');let len=Math.max(1,Math.round(channels[0].length/speed));if(len*channels.length>14000000)throw Error('処理結果が安全なメモリ上限を超えます');if(model==='period-joint'){
 if(jointBackend!==null&&!['pv','wsola','dual','am'].includes(jointBackend))
  throw Error('個別波長の残差モデルはPV・WSOLA・短長複合・AMのみ対応しています（Rust/WASMリアルタイムは未対応）');
 return renderJointAudio({
 channels,sampleRate,speed,semitones,sourceStartSeconds,periodCycles,
 renderResidual:(residual,frames)=>{
  // Compatibility: the original standalone joint mode keeps the fixed
  // PV(2048) residual, so historical K and inactive-window tests stay valid.
  const chosen=jointBackend||'pv';
  const result=renderPCM({channels:residual,sampleRate,speed,semitones,model:chosen,
    fftSize,shortFftSize,longFftSize:jointBackend?longFftSize:2048});
  if(result.channels.some(ch=>ch.length!==frames))throw RangeError('joint residual duration mismatch');
  return result.channels;
 }
});
}if(speed===1&&semitones===0)return {channels:channels.map(ch=>Float32Array.from(ch)),sampleRate};let p=Math.pow(2,semitones/12),stretch=p/speed,pitched=channels.map(ch=>resampleBandlimited(ch,p)),processed=model==='pv'?phaseVocoder(pitched,stretch,len,longFftSize):model==='wsola'?wsola(pitched,stretch,len,shortFftSize,sampleRate/p):model==='dual'?dualWindowVocoder(pitched,stretch,len,sampleRate,longFftSize,shortFftSize):amVocoder(pitched,stretch,len,sampleRate,longFftSize);for(let ch of processed)for(let i=0;i<ch.length;i++)if(!Number.isFinite(ch[i]))ch[i]=0;return {channels:processed,sampleRate};}
export function wav16({channels,sampleRate}){let count=channels[0].length,nc=channels.length,total=count*nc;if(total>14000000)throw Error('書出しメモリ上限');let buf=new ArrayBuffer(44+total*2),v=new DataView(buf),tag=(p,s)=>{for(let i=0;i<s.length;i++)v.setUint8(p+i,s.charCodeAt(i));};tag(0,'RIFF');v.setUint32(4,36+total*2,true);tag(8,'WAVE');tag(12,'fmt ');v.setUint32(16,16,true);v.setUint16(20,1,true);v.setUint16(22,nc,true);v.setUint32(24,sampleRate,true);v.setUint32(28,sampleRate*nc*2,true);v.setUint16(32,nc*2,true);v.setUint16(34,16,true);tag(36,'data');v.setUint32(40,total*2,true);let offset=44;for(let i=0;i<count;i++)for(let c=0;c<nc;c++){let s=clamp(channels[c][i],-1,1);v.setInt16(offset,s<0?Math.round(s*32768):Math.round(s*32767),true);offset+=2;}return buf;}
