import {test} from "node:test";
import assert from "node:assert/strict";
import {engineForInbandCurve} from "./engine-policy.mjs";
const defaults={low:100,high:1000,curvature:1,invert:0,mode:"blend"};
const core={warp_map_frequency:(f,l,h,p,a,m)=>f*(1-2*a)+a*(l+h)};
test("overall positive/negative shared-Rust curve selects B/A",()=>{
  assert.equal(engineForInbandCurve({...defaults,invert:0},core),1);
  assert.equal(engineForInbandCurve({...defaults,invert:0.499},core),1);
  assert.equal(engineForInbandCurve({...defaults,invert:0.501},core),0);
  assert.equal(engineForInbandCurve({...defaults,invert:1},core),0);
});
test("missing core and degenerate range fall back to manual-safe B",()=>{
  assert.equal(engineForInbandCurve(defaults,null),1);
  assert.equal(engineForInbandCurve({...defaults,high:100},core),1);
});
test("nonuniform local turns use whole-band trend",()=>{
  const folded={warp_map_frequency:f=>f<700?f:(1400-f)};
  assert.equal(engineForInbandCurve(defaults,folded),1);
  assert.equal(engineForInbandCurve(defaults,{warp_map_frequency:f=>f<250?f:1250-f}),0);
});
