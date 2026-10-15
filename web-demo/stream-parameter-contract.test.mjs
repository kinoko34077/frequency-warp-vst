import test from "node:test";
import assert from "node:assert/strict";
import {validateStreamSettings,prepareStreamSettings} from "./stream-parameter-contract.mjs";
const base=()=>({low:20,high:16000,sampleRate:48000,axisPivot:350,
 aMinHz:20,pitchRatio:1,carrierHz:350,axisShift:0,axisSlope:1,
 axisReference:350,shiftHz:-262.5,rationalEnabled:false,
 curvature:1,invert:0,mode:"reciprocal",outside:"pass",qualityIndex:0,
 engine:1,hopDiv:4,zeroMode:0,aReverb:0,aBandBins:1,aQuality:0,
 zeroReflectGain:1,zeroReflectDecay:0,crusherBits:0,crusherHold:1});
test("accepted active-audio bounds include the 1/20kHz reference endpoints",()=>{
 assert.equal(validateStreamSettings(base()).ok,true);
 assert.equal(validateStreamSettings({...base(),axisReference:1}).ok,true);
 assert.equal(validateStreamSettings({...base(),axisReference:20000,shiftHz:-20000}).ok,true);
});
test("out-of-core theoretical F is not clamped or silently applied",()=>{
 const p={...base(),axisReference:100000,rationalEnabled:false};
 assert.deepEqual(validateStreamSettings(p).field,"axisReference");
 assert.equal(p.axisReference,100000);
 assert.match(validateStreamSettings(p).message,/オーバーサンプリング/);
});
test("sub-1Hz axis anchor stays theoretical rather than accepted DSP",()=>{
 const p={...base(),axisReference:0.5,shiftHz:0};
 assert.equal(validateStreamSettings(p).field,"axisReference");
 assert.match(validateStreamSettings(p).message,/1Hz未満/);
});
test("Rust validates shift even when rational effect is switched off",()=>{
 for(const rationalEnabled of [false,true]){
  assert.equal(validateStreamSettings({...base(),rationalEnabled,shiftHz:20000.01}).field,"shiftHz");
  assert.equal(validateStreamSettings({...base(),rationalEnabled,shiftHz:20000}).ok,true);
 }
});
test("Nyquist mismatch is caught for playback and source-rate WAV",()=>{
 assert.equal(validateStreamSettings({...base(),sampleRate:32000}).field,"high");
 assert.equal(validateStreamSettings({...base(),sampleRate:48000}).ok,true);
});
test("nonfinite and inconsistent control inputs fail explicitly",()=>{
 assert.equal(validateStreamSettings({...base(),axisReference:NaN}).field,"axisReference");
 assert.equal(validateStreamSettings({...base(),low:17000}).field,"low");
 assert.equal(validateStreamSettings({...base(),carrierHz:20001}).field,"carrierHz");
});

test("complete accepted Rust snapshot permits all exact upper/lower setter boundaries",()=>{
  const p={...base(),curvature:0,invert:1,aReverb:1,
    zeroReflectGain:0,zeroReflectDecay:1,
    engine:3,qualityIndex:2,hopDiv:8,aBandBins:8,aQuality:100,
    crusherBits:16,crusherHold:1000000000,mode:"fold-h",outside:"kill"};
  assert.equal(validateStreamSettings(p).ok,true);
  assert.equal(validateStreamSettings({...p,crusherBits:0,crusherHold:0}).ok,true);
});
test("late setter invalid values are rejected before partial stream updates",()=>{
  const cases=[
    ["curvature",-0.01],["invert",1.01],["aReverb",NaN],
    ["aReverb",-0.001],["zeroReflectGain",1.01],
    ["zeroReflectDecay",-0.01],["qualityIndex",3],["qualityIndex",0.5],
    ["engine",4],["zeroMode",3],["hopDiv",5],
    ["aBandBins",0],["aBandBins",2.5],["aQuality",101],
    ["crusherBits",1],["crusherBits",17],
    ["crusherHold",-1],["crusherHold",1000000001],
    ["crusherHold",1.5],["mode","unrecognized"],["outside","unknown"]
  ];
  for(const [field,value] of cases){
    const payload={...base(),[field]:value};
    const before={...payload};
    assert.equal(validateStreamSettings(payload).field,field,
      field+"="+String(value)+" should fail before any Rust setter");
    assert.deepEqual(payload,before,"preflight must not mutate supplied theoretical values");
  }
});
test("mode, engine, quality and crusher controls keep their valid Rust variants",()=>{
  for(const mode of ["reciprocal","fold-h","fold-l","blend"]){
    for(const outside of ["pass","kill"]){
      assert.equal(validateStreamSettings({...base(),mode,outside}).ok,true);
    }
  }
  for(const crusherBits of [0,2,8,16])
    assert.equal(validateStreamSettings({...base(),crusherBits}).ok,true);
  for(const engine of [0,1,2,3])
    assert.equal(validateStreamSettings({...base(),engine}).ok,true);
});

test("0.001 Hz theoretical reference is retained while DSP plays from 1 Hz",()=>{
 const theoretical={...base(),low:0.001,axisPivot:0.001,
    aMinHz:0.001,axisReference:0.001,shiftHz:0};
 const previous={...theoretical};
 const resolved=prepareStreamSettings(theoretical);
 assert.equal(resolved.ok,true);
 assert.equal(resolved.settings.axisReference,1);
 assert.equal(resolved.settings.low,0.001);
 assert.equal(resolved.settings.aMinHz,0.001);
 assert.equal(resolved.settings.axisPivot,0.001);
 assert.deepEqual(theoretical,previous,"theoretical inputs and graph must not be overwritten");
 assert.match(resolved.warnings.join(" "),/1 Hz/);
 assert.match(resolved.warnings.join(" "),/0.001/);
 assert.equal(validateStreamSettings(resolved.settings).ok,true);
});

test("only sub-1Hz axis reference is adapted and all other failures stay explicit",()=>{
 for(const hz of [0,0.001,0.5,0.999999]) {
   const result=prepareStreamSettings({...base(),axisReference:hz});
   assert.equal(result.ok,true);
   assert.equal(result.settings.axisReference,1);
   assert.equal(result.warnings.length,1);
 }
 for(const hz of [1,350,20000]) {
   const result=prepareStreamSettings({...base(),axisReference:hz,shiftHz:0});
   assert.equal(result.ok,true);
   assert.equal(result.settings.axisReference,hz);
   assert.deepEqual(result.warnings,[]);
 }
 for(const hz of [-0.001,NaN,20001]) {
   assert.equal(prepareStreamSettings({...base(),axisReference:hz}).ok,false);
 }
 const bad={...base(),axisReference:0.001,high:25000};
 const resolved=prepareStreamSettings(bad);
 assert.equal(resolved.ok,false);
 assert.equal(resolved.field,"high");
 assert.equal(bad.axisReference,0.001);
});
