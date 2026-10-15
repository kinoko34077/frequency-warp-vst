import {test} from "node:test";
import assert from "node:assert/strict";
import {reconcileFrequencyBounds as R} from "./frequency-bounds.mjs";
const near=(a,b,tol=1e-10)=>assert.ok(Math.abs(a-b)<tol,`${a} != ${b}`);
test("changed L moves canonical H, never implicitly edits L on next render",()=>{
  const a=R({low:15500,high:16000,cap:20000,changed:"low"});
  assert.equal(a.low,15500);assert.equal(a.high,16740);
  assert.deepEqual(R({...a,cap:20000}),a,"a second labels/settings pass is idempotent");
});
test("changed H moves canonical L and all 6% gaps are stable",()=>{
  const a=R({low:15000,high:10000,cap:20000,changed:"high"});
  near(a.low,10000/1.08);assert.equal(a.high,10000);
  assert.deepEqual(R({...a,cap:20000}),a);
});
test("low/high clamp to physical cap and min before peer reconciliation",()=>{
  assert.deepEqual(R({low:25000,high:16000,cap:20000,changed:"low"}),
    {low:20000/1.08,high:20000});
  assert.deepEqual(R({low:.001,high:.001,cap:20000,changed:"high"}),
    {low:.001,high:.00108});
  assert.deepEqual(R({low:17000,high:9000,cap:10000,changed:"low"}),
    {low:10000/1.08,high:10000});
});
test("repeated random drags preserve separation and idempotence",()=>{
  for(let i=0;i<2500;i++){
    const cap=i%2?10000:20000;
    const low=.001+((i*5819)%25000);
    const high=.001+((i*4073)%25000);
    const a=R({low,high,cap,changed:i%3===0?"low":"high"});
    assert.ok(a.low>=.001&&a.high<=cap&&a.low<a.high,
      JSON.stringify(a));
    assert.ok(a.high+1e-8>=1.06*a.low,JSON.stringify(a));
    assert.deepEqual(R({...a,cap}),a);
  }
});
test("invalid/nonfinite source numbers fail without producing NaN DSP state",()=>{
  for(const pair of [{low:NaN,high:200},{low:100,high:Infinity},
    {low:10,high:20,cap:-1},{low:20,high:100,cap:0.00101}]){
    assert.throws(()=>R({cap:20000,...pair}),RangeError);
  }
});
