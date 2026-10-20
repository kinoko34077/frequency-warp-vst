import {test} from "node:test";
import assert from "node:assert/strict";
import {hzFromVirtualRootRail,virtualRootRailFromHz,
  virtualRootPercentFromHz,virtualRootHzFromPercent} from "./virtual-root-rail.mjs";
test("virtual root rail is linear, in integer Hz, with no logarithmic gesture",()=>{
  for(const hz of [1,2,25,87.5,350,10000,20000]){
    const rail=virtualRootRailFromHz(hz);
    assert.equal(rail.position,Math.round(hz));
    assert.equal(hzFromVirtualRootRail(rail.position),Math.round(hz));
    assert.equal(rail.limited,false);
  }
  assert.equal(hzFromVirtualRootRail(100),100);
  assert.equal(hzFromVirtualRootRail(101),101);
  assert.equal(virtualRootRailFromHz(0.01).position,1);
  assert.equal(virtualRootRailFromHz(.01).limited,true);
  assert.equal(virtualRootRailFromHz(30000).limited,true);
  assert.equal(virtualRootHzFromPercent(.5),10000.5);
  assert.equal(virtualRootPercentFromHz(10000.5),.5);
  assert.throws(()=>hzFromVirtualRootRail(0),RangeError);
  assert.throws(()=>virtualRootRailFromHz(0),RangeError);
});
