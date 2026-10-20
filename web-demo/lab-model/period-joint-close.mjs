// #20: bounded close-partial discovery from one shared audio-time model.
// 0.25 Hz is a SEARCH lattice only; output frequencies remain continuous.
// The source stays on its original timeline; observations never shift samples.
export const CLOSE_CANDIDATE_STEP_HZ=.25;
const TAU=2*Math.PI;
function solve(matrix,vector){
 const a=matrix.map((line,i)=>[...line,vector[i]]);
 const scale=a.reduce((s,row,i)=>s+row[i],0)/4;
 for(let i=0;i<4;i++)a[i][i]+=scale*1e-11;
 for(let col=0;col<4;col++){
  let at=col;
  for(let row=col+1;row<4;row++)if(Math.abs(a[row][col])>Math.abs(a[at][col]))at=row;
  if(Math.abs(a[at][col])<scale*1e-7)return null; // ill-conditioned near-identical f
  [a[col],a[at]]=[a[at],a[col]];
  const pivot=a[col][col];
  for(let j=col;j<=4;j++)a[col][j]/=pivot;
  for(let row=0;row<4;row++){
   if(row===col)continue;
   const k=a[row][col];
   for(let j=col;j<=4;j++)a[row][j]-=k*a[col][j];
  }
 }
 return a.map(row=>row[4]);
}
function pairFit(ch,sr,f1,f2,stride=1){
 const m=Array.from({length:4},()=>[0,0,0,0]),v=[0,0,0,0];
 let energy=0;
 for(let i=0;i<ch.length;i+=stride){
  const time=i/sr,p1=TAU*f1*time,p2=TAU*f2*time;
  const q=[Math.cos(p1),Math.sin(p1),Math.cos(p2),Math.sin(p2)],y=ch[i];
  energy+=y*y;
  for(let a=0;a<4;a++){v[a]+=q[a]*y;for(let b=0;b<=a;b++)m[a][b]+=q[a]*q[b];}
 }
 for(let a=0;a<4;a++)for(let b=a+1;b<4;b++)m[a][b]=m[b][a];
 const x=solve(m,v);
 if(!x)return null;
 let prediction=0;for(let i=0;i<4;i++)prediction+=x[i]*v[i];
 return {coefficients:[{a:x[0],b:x[1]},{a:x[2],b:x[3]}],
   residual:Math.max(0,energy-prediction),energy};
}
function singleFit(ch,sr,f,stride){
 let cc=0,cs=0,ss=0,cy=0,sy=0,energy=0;
 for(let i=0;i<ch.length;i+=stride){
  const angle=TAU*f*i/sr,c=Math.cos(angle),s=Math.sin(angle),y=ch[i];
  cc+=c*c;cs+=c*s;ss+=s*s;cy+=c*y;sy+=s*y;energy+=y*y;
 }
 const d=cc*ss-cs*cs;
 if(d<1e-12)return {residual:energy,energy};
 const a=(cy*ss-sy*cs)/d,b=(sy*cc-cy*cs)/d;
 return {residual:Math.max(0,energy-a*cy-b*sy),energy};
}
export function transportSourcePhase(localPhase,frequency,sourceAtSeconds,referenceAtSeconds=0){
 if(![localPhase,frequency,sourceAtSeconds,referenceAtSeconds].every(Number.isFinite)||frequency<0)throw RangeError('invalid phase transport');
 // f is not rounded. Different observation timestamps are mapped to the
 // SAME reference time; never splice 440@4.41s to 441@4.40s.
 const cycles=frequency*(referenceAtSeconds-sourceAtSeconds);
 const reduced=cycles-Math.round(cycles);
 const phi=localPhase+TAU*reduced;
 return Math.atan2(Math.sin(phi),Math.cos(phi));
}
export function detectClosePair({channels,sampleRate,peakFrequency,minSpan=.25,maxSpan=2.5}){
 const L=channels[0]?.length||0,sr=sampleRate;
 if(!Number.isFinite(sr)||!Number.isFinite(peakFrequency)||L<sr*1||
   peakFrequency<50||peakFrequency>Math.min(5000,sr*.42))return null;
 let guide=channels[0],power=-1;
 for(const ch of channels){let e=0;for(let i=0;i<L;i+=16)e+=ch[i]*ch[i];if(e>power){power=e;guide=ch;}}
 if(power<1e-8)return null;
 const stride=Math.max(1,Math.floor(L/3072));
 // A highly accurate one-sinusoid baseline prevents creating artificial
 // two-tone explanations for a single fractional-frequency sinusoid.
 let single=null;
 for(let offset=-2;offset<=2.0001;offset+=.25){
  const f=peakFrequency+offset;
  if(f<45||f>sr*.44)continue;
  const candidate=singleFit(guide,sr,f,stride);
  if(!single||candidate.residual<single.residual)single={...candidate,frequency:f};
 }
 if(!single)return null;
 let best=null;
 const consider=(center,span)=>{
  const f1=center-span/2,f2=center+span/2;
  if(f1<45||f2>sr*.44)return;
  const fit=pairFit(guide,sr,f1,f2,stride);
  if(!fit)return;
  if(!best||fit.residual<best.residual)best={...fit,frequencies:[f1,f2]};
 };
 // The 0.25Hz lattice is anchored around the FFT guess; both center and
 // spacing are permitted to move off-lattice during final optimization.
 for(let offset=-1.5;offset<=1.5001;offset+=CLOSE_CANDIDATE_STEP_HZ){
  for(let span=minSpan;span<=maxSpan+.0001;span+=CLOSE_CANDIDATE_STEP_HZ)
   consider(peakFrequency+offset,span);
 }
 if(!best)return null;
 for(const step of [.05,.01]){
  const center=(best.frequencies[0]+best.frequencies[1])/2;
  const span=best.frequencies[1]-best.frequencies[0];
  for(let u=-2;u<=2;u++)for(let v=-2;v<=2;v++){
   const s=span+v*step;
   if(s>=.22&&s<=maxSpan+.2)consider(center+u*step,s);
  }
 }
 // Compare against a CONTINUOUS single-tone best fit. Without this test
 // two close sinusoids can spuriously approximate a single drifting tone.
 for(let offset=-.3;offset<=.3001;offset+=.025){
  const f=single.frequency+offset;
  const candidate=singleFit(guide,sr,f,stride);
  if(candidate.residual<single.residual)single={...candidate,frequency:f};
 }
 const gain=single.residual-best.residual;
 if(!(gain>single.energy*.035&&gain>single.residual*.22))return null;
 const amp=best.coefficients.map(({a,b})=>Math.hypot(a,b));
 if(Math.min(...amp)<Math.max(...amp)*.08)return null;
 // Full-resolution final channel coefficients share the SAME two f values.
 const fitted=channels.map(ch=>pairFit(ch,sr,...best.frequencies,1));
 if(fitted.some(v=>!v))return null;
 let fullResidual=0,fullEnergy=0;
 for(const f of fitted){fullResidual+=f.residual;fullEnergy+=f.energy;}
 return {partials:best.frequencies.map((frequency,j)=>({
    frequency,coefficients:fitted.map(f=>f.coefficients[j]),explainedInResidual:1-fullResidual/(fullEnergy+1e-12)
   })),
   frequencies:best.frequencies,explained:1-fullResidual/(fullEnergy+1e-12),
   baselineSingleHz:single.frequency,improvement:gain/single.energy,gridHz:CLOSE_CANDIDATE_STEP_HZ};
}
