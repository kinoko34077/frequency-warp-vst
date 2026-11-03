import {test} from "node:test";
import assert from "node:assert/strict";
import {reconcileFrequencyBounds as R,audioFrequencyCap} from "./frequency-bounds.mjs";

test("preserves arbitrary close L/H frequencies",()=>{
  assert.deepEqual(R({low:15500,high:16000,cap:20000,changed:"low"}),{low:15500,high:16000});
  assert.deepEqual(R({low:19999.9999,high:20000,cap:20000}),{low:19999.9999,high:20000});
  assert.deepEqual(R({low:.001,high:.001000000001,cap:20000}),{low:.001,high:.001000000001});
});
test("collision moves one peer minimally and stabilizes",()=>{
  const a=R({low:15000,high:10000,cap:20000,changed:"high"});
  assert.equal(a.high,10000);assert.ok(a.low<a.high);
  assert.deepEqual(R({...a,cap:20000}),a);
  const b=R({low:25000,high:16000,cap:20000,changed:"low"});
  assert.equal(b.high,20000);assert.ok(b.low<b.high);
  assert.deepEqual(R({...b,cap:20000}),b);
  const c=R({low:.001,high:.001,cap:20000,changed:"high"});
  assert.equal(c.low,.001);assert.ok(c.high>c.low);
});
test("random bounds remain ordered and idempotent",()=>{
  for(let i=0;i<2500;i++){
    const cap=i%2?10000:20000;
    const a=R({low:.001+(i*5819)%25000,high:.001+(i*4073)%25000,cap,changed:i%3===0?"low":"high"});
    assert.ok(a.low>=.001&&a.high<=cap&&a.low<a.high,JSON.stringify(a));
    assert.deepEqual(R({...a,cap}),a);
  }
});
test("physical Nyquist ceiling is not 45 percent",()=>{
  assert.equal(audioFrequencyCap(44100),20000);
  assert.equal(audioFrequencyCap(48000),20000);
  const cap=audioFrequencyCap(32000);
  assert.ok(cap<16000&&cap>15999.999999);
});
test("invalid and nonfinite bounds fail",()=>{
  for(const x of [{low:NaN,high:200},{low:100,high:Infinity},{low:10,high:20,cap:-1},{low:20,high:100,cap:.001}])
    assert.throws(()=>R({cap:20000,...x}),RangeError);
});
