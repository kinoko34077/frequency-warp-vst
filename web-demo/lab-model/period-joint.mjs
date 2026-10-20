// #20 — limited single stationary tone, NOT general source identification.
// Multiple frequency-dependent windows constrain ONE shared latent oscillator.
const TAU=2*Math.PI;
export const PERIOD_MODEL_ID='period-joint';
export const PERIOD_K=8, WINDOW_COUNT=7;
export const PERIOD_CYCLE_CHOICES=Object.freeze([.5,1,2,4,8,16,32]);
export function integerReferenceHz(f){
 if(!Number.isFinite(f)||f>=1e9||f<.5)throw RangeError('positive reference frequency');
 return Math.floor(f+.5); // n-.5 <= f < n+.5; f is not quantized
}
export function theoreticalWindow(f,K=PERIOD_K){
 if(!Number.isFinite(f)||f<=0||!Number.isFinite(K)||K<.5||K>128)throw RangeError('invalid frequency/period count');
 return K/f;
}
export function gcd(a,b){
 if(!Number.isSafeInteger(a)||!Number.isSafeInteger(b)||a<=0||b<=0)throw RangeError('integer Hz only');
 while(b)[a,b]=[b,a%b];
 return a;
}
export function commonBoundary(a,b,K=PERIOD_K){
 theoreticalWindow(1,K);
 return K/gcd(a,b);
}
export function sampleInterval(center,f,sampleRate,K=PERIOD_K){
 if(!Number.isFinite(center)||!Number.isFinite(sampleRate)||sampleRate<=0)throw RangeError('invalid sample clock');
 const half=theoreticalWindow(f,K)/2;
 return {leftSeconds:center-half,rightSeconds:center+half,
   firstSample:Math.ceil((center-half)*sampleRate),endSample:Math.ceil((center+half)*sampleRate)};
}
function weightedFit(signal,sr,f,centers,K){
 let uu=0,uv=0,vv=0,yu=0,yv=0,energy=0;
 for(const center of centers){
  const limits=sampleInterval(center,f,sr,K),half=theoreticalWindow(f,K)/2;
  for(let j=Math.max(0,limits.firstSample);j<Math.min(signal.length,limits.endSample);j++){
   const t=j/sr,d=(t-center)/half;
   if(Math.abs(d)>=1)continue;
   const w=.5+.5*Math.cos(Math.PI*d),arg=TAU*f*t,c=Math.cos(arg),s=Math.sin(arg),y=signal[j];
   uu+=w*c*c;uv+=w*c*s;vv+=w*s*s;yu+=w*y*c;yv+=w*y*s;energy+=w*y*y;
  }
 }
 const determinant=uu*vv-uv*uv;
 if(!(determinant>1e-12))throw RangeError('insufficient window observations');
 const a=(yu*vv-yv*uv)/determinant,b=(yv*uu-yu*uv)/determinant;
 const residual=Math.max(0,energy-a*yu-b*yv);
 return {a,b,frequency:f,energy,residual,explained:energy>1e-12?Math.max(0,1-residual/energy):1};
}
function search(ch,sr,centers,K,lo,hi,step){
 let best;
 const count=Math.ceil((hi-lo)/step);
 for(let i=0;i<=count;i++){
  const f=Math.min(hi,lo+i*step);
  if(f<=0||f>=sr*.45)continue;
  const trial=weightedFit(ch,sr,f,centers,K);
  if(!best||trial.explained>best.explained)best=trial;
 }
 if(!best)throw RangeError('no frequency candidates');
 return best;
}
export function estimateJointTone({channels,sampleRate,K=PERIOD_K}){
 if(!Array.isArray(channels)||channels.length<1||channels.length>2||
    !Number.isFinite(sampleRate)||sampleRate<8000||sampleRate>192000)throw RangeError('invalid source');
 const L=channels[0]?.length||0;
 if(L<sampleRate*.2||L>sampleRate*3||channels.some(ch=>ch.length!==L))throw RangeError('0.2..3 seconds and matching channel lengths required');
 let guide=channels[0],largest=-1;
 for(const ch of channels){
  let e=0;for(let i=0;i<L;i+=8)e+=ch[i]**2;
  if(e>largest){largest=e;guide=ch;}
 }
 if(largest<1e-10)return {frequency:0,referenceHz:0,explained:1,coefficients:channels.map(()=>({a:0,b:0})),silent:true};
 const duration=L/sampleRate,local=[duration/2];
 const centers=Array.from({length:WINDOW_COUNT},(_,i)=>duration*(i+.5)/WINDOW_COUNT);
 const high=Math.min(1600,Math.floor(sampleRate*.4));
 // One-window local candidate discovery (not reconstruction); final fit
 // shares frequency, amplitude and phase over seven separate observations.
 const coarse=search(guide,sampleRate,local,K,80,high,20);
 const medium=search(guide,sampleRate,local,K,Math.max(80,coarse.frequency-30),Math.min(high,coarse.frequency+30),1);
 const fine=search(guide,sampleRate,centers,K,Math.max(80,medium.frequency-1),Math.min(high,medium.frequency+1),.1);
 const exact=search(guide,sampleRate,centers,K,Math.max(80,fine.frequency-.12),Math.min(high,fine.frequency+.12),.01);
 const coefficients=channels.map(ch=>weightedFit(ch,sampleRate,exact.frequency,centers,K));
 // Held-out-in-time verification: the seven short observations are NOT the
 // whole waveform. A strong attack/noise between observation centers must
 // not be silently erased by an apparently excellent window-only fit.
 let fullExplained=0;
 for(let c=0;c<channels.length;c++){
  const ch=channels[c],{a,b}=coefficients[c];let energy=0,error=0;
  for(let i=0;i<ch.length;i++){
   const t=i/sampleRate,y=ch[i],phase=TAU*exact.frequency*t;
   const residual=y-a*Math.cos(phase)-b*Math.sin(phase);
   energy+=y*y;error+=residual*residual;
  }
  fullExplained+=energy>1e-12?Math.max(0,1-error/energy):1;
 }
 fullExplained/=channels.length;
 return {frequency:exact.frequency,referenceHz:integerReferenceHz(exact.frequency),
  explained:coefficients.reduce((sum,c)=>sum+c.explained,0)/coefficients.length,fullExplained,
  coefficients,windows:WINDOW_COUNT,periods:K,silent:false};
}
export function renderPeriodJointTone({channels,sampleRate,speed=1,semitones=0,sourceStartSeconds=0}){
 if(!Number.isFinite(speed)||speed<.5||speed>2||!Number.isFinite(semitones)||semitones<-12||semitones>12)throw RangeError('invalid speed/pitch');
 if(!(Number.isFinite(sourceStartSeconds)&&sourceStartSeconds>=0))throw RangeError('invalid source origin');
 const estimate=estimateJointTone({channels,sampleRate});
 const frames=Math.max(1,Math.round(channels[0].length/speed));
 if(frames*channels.length>14_000_000)throw RangeError('memory bound');
 if(!estimate.silent&&(estimate.explained<.90||estimate.fullExplained<.90))throw Error('個別周期・共同推定の試験版は単一定常純音のみ対応（複音・変調・打音は未対応）');
 const f=estimate.frequency*2**(semitones/12);
 // Project chunk-local fitted phase onto a common absolute source timeline.
 // This ensures the *stationary-tone* model does not restart phase at each
 // processed segment; time-varying multi-tone phase continuity remains future work.
 return {channels:estimate.coefficients.map(({a,b})=>{
  const amp=Math.hypot(a,b),phase=Math.atan2(-b,a)-TAU*estimate.frequency*sourceStartSeconds;
  return Float32Array.from({length:frames},(_,i)=>
   amp*Math.cos(phase+TAU*f*(sourceStartSeconds/speed+i/sampleRate)));
 }),sampleRate,
 diagnostics:{...estimate,outFrequency:f}};
}
