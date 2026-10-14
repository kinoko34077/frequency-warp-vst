/** Choose the engine from the final audible/displayed in-band curve.
 * The sampler is shared with the plot: Rust/WASM mapping + physical pivot,
 * ratio / shift, 0-Hz policy and Nyquist. The graph's zoom or logarithmic
 * axis *presentation* cannot affect the frequency mapping itself.
 *
 * A is chosen only for an overall descending trend of surviving in-band
 * frequencies (regression slope); short local fold kinks do not force A.
 * When no meaningful audible segment remains, choose B rather than
 * misreporting a direction.
 */
export function engineForInbandCurve(s,sampleOutput){
  const low=Number(s.low),high=Number(s.high);
  if(typeof sampleOutput!=="function" ||
     !Number.isFinite(low)||!Number.isFinite(high)||high<=low)return 1;
  const points=[];
  for(let i=0;i<=64;i++){
    const x=low+(high-low)*i/64;
    const y=sampleOutput(x);
    if(Number.isFinite(y)&&y>0)points.push([x,y]);
  }
  if(points.length<3)return 1;
  const xm=points.reduce((sum,[x])=>sum+x,0)/points.length;
  const ym=points.reduce((sum,[,y])=>sum+y,0)/points.length;
  let numerator=0,denominator=0;
  for(const [x,y] of points){
    numerator+=(x-xm)*(y-ym);
    denominator+=(x-xm)*(x-xm);
  }
  return denominator>0 && numerator/denominator < -1e-6 ? 0 : 1;
}
