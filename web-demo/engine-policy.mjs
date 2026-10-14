/** Engine auto policy: inspect the SAME Rust/WASM warp curve used by audio.
 * A is selected when the in-band frequency map has negative overall trend.
 * Display-axis logarithmic interpolation never changes this sign.
 */
export function engineForInbandCurve(s,sharedCore){
  if(!sharedCore?.warp_map_frequency)return 1;
  const low=Number(s.low),high=Number(s.high);
  if(!Number.isFinite(low)||!Number.isFinite(high)||high<=low)return 1;
  const mode=s.mode==="blend"?1:s.mode==="fold-l"?2:0;
  let sx=0,sy=0,sxx=0,sxy=0,count=0;
  for(let i=0;i<=32;i++){
    const x=low+(high-low)*i/32;
    const y=sharedCore.warp_map_frequency(x,low,high,s.curvature,s.invert,mode);
    if(!Number.isFinite(y))continue;
    sx+=x;sy+=y;sxx+=x*x;sxy+=x*y;count++;
  }
  if(count<3)return 1;
  // Least-squares slope of the whole in-band curve (not a single local kink).
  const denominator=count*sxx-sx*sx;
  return denominator>0 && (count*sxy-sx*sy)/denominator < -1e-6 ? 0 : 1;
}
