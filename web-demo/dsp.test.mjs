import {test} from "node:test";
import assert from "node:assert/strict";
import {mapFrequency,mixWet,QUALITY} from "./dsp.mjs";

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
  assert.ok(Math.abs(mapFrequency(500,20,20000,1,.5,"fold")
    -mapFrequency(1500,20,20000,1,.5,"fold"))>100);
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
