import {test} from "node:test";
import assert from "node:assert/strict";
import {createVirtualRootPlan,virtualRootStatus} from "./virtual-root-plan.mjs";
const approx=(a,b,eps=1e-11)=>assert.ok(Math.abs(a-b)<=eps,`${a} != ${b}`);

test("issue #24: arbitrary virtual root creates correct sparse indices while pitch location moves",()=>{
  const cases=[
    {F:100,H:25,m:4,h1:1,r:1,shift:-75,values:[25,125,225],indexes:[1,5,9]},
    {F:100,H:20,m:4,h1:1,r:.8,shift:-60,values:[20,100,180],indexes:[1,5,9]},
    {F:100,H:30,m:4,h1:1,r:1.2,shift:-90,values:[30,150,270],indexes:[1,5,9]},
    {F:350,H:87.5,m:4,h1:3,r:1,shift:-87.5,values:[262.5,612.5,962.5],indexes:[3,7,11]},
    {F:350,H:70,m:5,h1:6,r:1,shift:70,values:[420,770,1120],indexes:[6,11,16]}
  ];
  for(const c of cases){
    const p=createVirtualRootPlan(c);
    approx(p.ratio,c.r);approx(p.shift,c.shift);
    assert.deepEqual(p.outputs.slice(0,3).map(x=>x.output),c.values);
    assert.deepEqual(p.outputs.slice(0,3).map(x=>x.gridIndex),c.indexes);
    assert.equal(p.hasPhysicalRoot,c.h1===1);
    assert.deepEqual(p.fraction,{n:c.h1-c.m,m:c.m});
  }
});
test("issue #16: q moves which actually reflected source partial arrives at H",()=>{
  const q1=createVirtualRootPlan({F:100,H:25,m:4,q:1,mode:"fold-to-root"});
  approx(q1.shift,-125);
  assert.equal(q1.numerator,-5);
  assert.deepEqual(q1.outputs.slice(0,3).map(x=>x.output),[25,75,175]);
  assert.equal(q1.outputs[0].reflected,true);
  assert.equal(q1.outputs[0].atRoot,true);
  const q2=createVirtualRootPlan({F:350,H:87.5,m:4,q:2,mode:"fold-to-root"});
  approx(q2.shift,-787.5);
  assert.equal(q2.numerator,-9);
  assert.deepEqual(q2.outputs.slice(0,5).map(x=>x.output),[437.5,87.5,262.5,612.5,962.5]);
  assert.equal(q2.outputs[1].atRoot,true);
  assert.equal(q2.outputs[1].reflected,true);
  assert.equal(q2.outputs[0].atRoot,false);
});
test("keep spacing mode refuses to counterfeit independently selected H",()=>{
  const p=createVirtualRootPlan({F:100,H:3,m:4,h1:1,placement:"keep-spacing"});
  assert.equal(p.H,25);
  assert.equal(p.ratio,1);
  assert.deepEqual(p.outputs.slice(0,3).map(x=>x.output),[25,125,225]);
  const t=createVirtualRootPlan({F:100,H:3,m:4,h1:1,placement:"target"});
  assert.equal(t.H,3);
  assert.equal(t.ratio,.12);
  assert.equal(t.capability.theoryOnly,true);
});
test("below .001Hz remains strictly positive; P=0 is NOT faked; link never force-unchecks",()=>{
  for(const H of [.0009,.0001,.0000001,.001,.01,1,20000,20001]){
    const p=createVirtualRootPlan({F:350,H,m:4});
    assert.equal(p.H,H);
    assert.ok(p.outputs[0].output>0);
    assert.ok(p.pitched>0);
    assert.equal(p.capability.physicalPivot,H>=.001&&H<=20000);
    assert.ok(!("unlink" in p));
  }
  const p=createVirtualRootPlan({F:350,H:.0009,m:4});
  approx(p.ratio,4*.0009/350,1e-16);
  assert.ok(p.capability.notes.length);
  assert.match(virtualRootStatus(p),/理論配置/);
  assert.throws(()=>createVirtualRootPlan({F:350,H:0,m:4}),RangeError);
  assert.throws(()=>createVirtualRootPlan({F:350,H:-1,m:4}),RangeError);
  assert.throws(()=>createVirtualRootPlan({F:350,H:Infinity,m:4}),RangeError);
  assert.throws(()=>createVirtualRootPlan({F:350,H:NaN,m:4}),RangeError);
});
test("ordinary q cannot create a fake audible change; only selected reflect mode uses q",()=>{
  const a=createVirtualRootPlan({F:350,H:87.5,m:4,h1:1,q:1});
  const b=createVirtualRootPlan({F:350,H:87.5,m:4,h1:1,q:19});
  assert.equal(a.shift,b.shift);
  assert.deepEqual(a.outputs,b.outputs.map(v=>({...v})));
  const c=createVirtualRootPlan({F:350,H:87.5,m:4,q:19,mode:"fold-to-root",count:3});
  assert.notEqual(a.shift,c.shift);
  assert.ok(c.outputs.some(v=>v.reflected));
});
test("no silent overflow, fake 0 or clamp at current DSP boundaries",()=>{
  const high=createVirtualRootPlan({F:350,H:30000,m:4});
  assert.equal(high.H,30000);
  assert.equal(high.capability.rationalStage,false);
  assert.equal(high.capability.physicalPivot,false);
  assert.throws(()=>createVirtualRootPlan({F:100,H:1e308,m:64}),RangeError);
  assert.throws(()=>createVirtualRootPlan({F:100,H:25,m:0}),RangeError);
});


test("V5 signed arithmetic progression folds negative terms automatically with no mode toggle",()=>{
  const p=createVirtualRootPlan({F:350,H:87.5,m:4,h1:-5,mode:"auto-fold"});
  assert.equal(p.numerator,-9);
  assert.deepEqual(p.outputs.slice(0,5).map(v=>v.gridIndex),[5,1,3,7,11]);
  assert.deepEqual(p.outputs.slice(0,5).map(v=>v.output),[437.5,87.5,262.5,612.5,962.5]);
  assert.equal(p.outputs[0].reflected,true);
  assert.equal(p.outputs[1].atRoot,true);
  assert.equal(p.hasPhysicalRoot,true);
  const origin=createVirtualRootPlan({F:100,H:25,m:2,h1:0,mode:"auto-fold"});
  assert.equal(origin.outputs[0].output,0);
  assert.equal(origin.outputs[1].output,50);
  const negative=createVirtualRootPlan({F:350,H:87.5,m:4,h1:-129,mode:"auto-fold"});
  assert.equal(negative.capability.rationalStage,false,"theory remains representable");
});
