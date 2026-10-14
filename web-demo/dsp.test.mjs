import {test} from "node:test";
import assert from "node:assert/strict";
import {mixWet,QUALITY} from "./dsp.mjs";
import {mapFrequency} from "./mapping-oracle.test-helper.mjs";

test("UI preview follows the shared curvature formula",()=>{
  for(const p of [0,.001,.25,.5,1]){
    for(const f of [20,100,1000,10000,20000]){
      const t=mapFrequency(f,20,20000,p,1);
      assert.ok(Math.abs(mapFrequency(t,20,20000,p,1)-f)<1e-6);
      assert.equal(mapFrequency(f,20,20000,p,0),f);
    }
  }
});
test("L/H folding avoids linear-blend midpoint collapse",()=>{
  assert.ok(Math.abs(mapFrequency(500,20,20000,1,.5,"blend")
    -mapFrequency(1500,20,20000,1,.5,"blend"))<1e-8);
  assert.ok(Math.abs(mapFrequency(500,20,20000,1,.5,"fold-h")
    -mapFrequency(1500,20,20000,1,.5,"fold-h"))>100);
});
test("independent Wet is samplewise mixture",()=>{
  const dry=Float32Array.from([.8,-.5,.2]);
  const processed=Float32Array.from([-.2,.7,0]);
  assert.deepEqual(Array.from(mixWet(dry,processed,0)),Array.from(dry));
  assert.deepEqual(Array.from(mixWet(dry,processed,1)),Array.from(processed));
});
test("Quality UI profiles are distinct",()=>{
  assert.ok(QUALITY.eco.fftSize<QUALITY.standard.fftSize);
  assert.ok(QUALITY.standard.fftSize<QUALITY.high.fftSize);
});

test("H/L fold directions are different at partial invert, equal at complete inversion",()=>{
  for(const p of [0,0.3,1]){
    for(const f of [100,500,1200]){
      const high=mapFrequency(f,20,3000,p,.4,"fold-h");
      const low=mapFrequency(f,20,3000,p,.4,"fold-l");
      assert.ok(Math.abs(high-low)>1);
      const fullH=mapFrequency(f,20,3000,p,1,"fold-h");
      const fullL=mapFrequency(f,20,3000,p,1,"fold-l");
      assert.ok(Math.abs(fullH-fullL)<1e-7);
    }
  }
});
