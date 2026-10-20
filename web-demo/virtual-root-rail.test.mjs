import {test} from "node:test";
import assert from "node:assert/strict";
import {hzFromVirtualRootRail,virtualRootRailFromHz} from "./virtual-root-rail.mjs";

test("virtual H rail never maps a nonzero gesture to physical P=0",()=>{
  assert.equal(hzFromVirtualRootRail(0),1e-12);
  assert.ok(hzFromVirtualRootRail(1)>0);
  assert.ok(hzFromVirtualRootRail(999)>0);
  for(const hz of [1e-10,.0001,.0009,.001,.01,20,350,10000,20000]){
    const m=virtualRootRailFromHz(hz);
    assert.equal(m.limited,false);
    assert.ok(m.position>=0&&m.position<=1000);
    assert.ok(hzFromVirtualRootRail(m.position)>0);
  }
  assert.equal(virtualRootRailFromHz(1e-14).limited,true);
  assert.equal(virtualRootRailFromHz(50000).limited,true);
  assert.throws(()=>hzFromVirtualRootRail(-1),RangeError);
  assert.throws(()=>virtualRootRailFromHz(0),RangeError);
});
