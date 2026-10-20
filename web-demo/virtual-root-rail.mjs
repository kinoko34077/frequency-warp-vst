/** #276 V5: direct linear-H gesture rail with integer Hz increments.
 * A typed positive sub-1Hz H is retained, though the physical slider shows 1Hz.
 * Percent denotes position on this linear rail, not percent of its Hz value.
 */
export const VIRTUAL_ROOT_RAIL_MIN=1;
export const VIRTUAL_ROOT_RAIL_MAX=20000;
export function hzFromVirtualRootRail(position){
  if(!Number.isFinite(position)||position<1||position>20000)
    throw RangeError("Invalid H rail position");
  return Math.round(position);
}
export function virtualRootRailFromHz(hz){
  if(!Number.isFinite(hz)||hz<=0)throw RangeError("Positive Hz required");
  return Object.freeze({
    position:Math.round(Math.max(1,Math.min(20000,hz))),
    limited:hz<1||hz>20000,
    lowerBound:1,upperBound:20000
  });
}
export const virtualRootPercentFromHz=hz=>
  (Math.max(1,Math.min(20000,hz))-1)/19999;
export const virtualRootHzFromPercent=position=>{
  if(!Number.isFinite(position)||position<0||position>1)
    throw RangeError("Invalid H position");
  return 1+19999*position;
};
