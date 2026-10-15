import test from "node:test";
import assert from "node:assert/strict";
import {validateStreamSettings} from "./stream-parameter-contract.mjs";
const base=()=>({low:20,high:16000,sampleRate:48000,axisPivot:350,
 aMinHz:20,pitchRatio:1,carrierHz:350,axisShift:0,axisSlope:1,
 axisReference:350,shiftHz:-262.5,rationalEnabled:false});
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
