import {test} from "node:test";
import assert from "node:assert/strict";
import {engineForInbandCurve} from "./engine-policy.mjs";
import {mapAtFrequency} from "./harmonics.mjs";

const controls={low:100,high:500,curvature:1,invert:0,mode:"blend",
 outside:"pass",axisReference:350,axisShift:-2,axisSlope:1,axisPivot:350,
 zeroMode:0,sampleRate:48000};
const warp=(f,l,h,p,amount)=>f*(1-2*amount)+amount*(l+h);
const translate=(f,pivot,p,shift,slope,anchor)=>
  pivot+slope*(f-anchor)+shift*controls.axisReference;

test("auto engine reads final audible curve, including 0-Hz reflection",()=>{
  const c={...controls,axisShift:-2,zeroMode:0};
  const sample=f=>mapAtFrequency(f,c,warp,translate).outputs[0];
  assert.equal(engineForInbandCurve(c,sample),0,
    "non-inverted but fully reflected output descends and needs engine A");
  assert.equal(engineForInbandCurve({...c,zeroMode:1},
    f=>mapAtFrequency(f,{...c,zeroMode:1},warp,translate).outputs[0]),1,
    "killed curve must not pretend to be descending");
});
test("full inversion reflected below zero rises despite negative raw warp",()=>{
  const c={...controls,invert:1,axisShift:-4,zeroMode:0};
  const sample=f=>mapAtFrequency(f,c,warp,translate).outputs[0];
  assert.equal(engineForInbandCurve(c,sample),1);
});
test("positive, negative, mixed, and absent curves have safe overall trend",()=>{
  const base={low:100,high:1000};
  assert.equal(engineForInbandCurve(base,f=>f),1);
  assert.equal(engineForInbandCurve(base,f=>1100-f),0);
  assert.equal(engineForInbandCurve(base,f=>f<700?f:1400-f),1);
  assert.equal(engineForInbandCurve(base,f=>f<250?f:1250-f),0);
  assert.equal(engineForInbandCurve(base,()=>undefined),1);
  assert.equal(engineForInbandCurve(base,null),1);
  assert.equal(engineForInbandCurve({...base,high:100},f=>f),1);
});
test("display scaling must not affect DSP auto A/B selection",()=>{
  const base={low:100,high:1000};
  const sampled=f=>1100-f;
  assert.equal(engineForInbandCurve(base,sampled),0);
});
