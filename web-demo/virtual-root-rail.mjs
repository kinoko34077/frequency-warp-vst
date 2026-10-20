/** Pure positive-only logarithmic H gesture rail.
 * Unlike the physical P slider, position 0 NEVER denotes frequency zero.
 * Typed values outside the rail are NOT clamped in the canonical model.
 */
const MIN=1e-12,MAX=20000,SPAN=Math.log(MAX/MIN);
export function hzFromVirtualRootRail(position){
  if(!Number.isFinite(position)||position<0||position>1000)
    throw RangeError("Invalid H rail position");
  return MIN*Math.exp(SPAN*position/1000);
}
export function virtualRootRailFromHz(hz){
  if(!Number.isFinite(hz)||hz<=0)throw RangeError("Positive Hz required");
  const limited=hz<MIN||hz>MAX;
  const shown=Math.max(MIN,Math.min(MAX,hz));
  return Object.freeze({
    position:Math.round(1000*Math.log(shown/MIN)/SPAN),limited,
    lowerBound:MIN,upperBound:MAX
  });
}
