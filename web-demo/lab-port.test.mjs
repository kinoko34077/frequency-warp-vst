import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {validateStreamSettings} from './stream-parameter-contract.mjs';
const read=p=>readFileSync(new URL(p,import.meta.url),'utf8');
const base=()=>({low:20,high:16000,sampleRate:48000,axisPivot:350,
 aMinHz:20,pitchRatio:1,carrierHz:350,axisShift:0,axisSlope:1,
 axisReference:350,shiftHz:0,rationalEnabled:false,curvature:1,invert:0,
 mode:'reciprocal',outside:'pass',qualityIndex:1,engine:0,hopDiv:4,zeroMode:0,
 aReverb:0,aBandBins:1,aQuality:0,zeroReflectGain:1,zeroReflectDecay:0,
 crusherBits:0,crusherHold:1});
test('accepted K choices and disabled legacy A/B handling',()=>{
 for(const k of [0,.5,1,2,4,8,16,32]){
  assert.equal(validateStreamSettings({...base(),individualCycles:k}).ok,true);
 }
 for(const k of [-1,.75,3,64,NaN]){
  assert.equal(validateStreamSettings({...base(),individualCycles:k}).field,'individualCycles');
 }
 assert.equal(validateStreamSettings({...base(),engine:1,individualCycles:8}).field,'individualCycles');
 assert.equal(validateStreamSettings({...base(),engine:1,individualCycles:0}).ok,true);
});
test('individual-period UI lives INSIDE the original Settings dialog, no extra audition control',()=>{
 const html=read('./index.html');
 const dialog=html.slice(html.indexOf('<dialog id="settings-dialog"'),html.indexOf('</dialog>')+9);
 assert.match(dialog,/id="engine"/);
 assert.match(dialog,/id="individual-enabled"/);
 assert.match(dialog,/id="individual-cycles"/);
 assert.match(dialog,/id="quality"/);
 for(const obsolete of ['lab-port-panel','lab-port-preview','lab-port-apply-warp','lab-port-stop']){
  assert.doesNotMatch(html,new RegExp(obsolete));
 }
});
test('same actual Rust real-time control and WAV export use new native K ABI',()=>{
 const app=read('./app.mjs'),live=read('./realtime.worklet.js'),wav=read('./processor.worker.mjs');
 assert.doesNotMatch(app,/mountLabComparison/);
 assert.match(app,/individualCycles:.*individual-enabled/);
 assert.match(app,/AudioWorkletNode\(ctx,"frequency-warp-rust"/);
 assert.match(live,/warp_stream_set_individual_cycles/);
 assert.match(wav,/warp_stream_render_f32_individual_cycles_ext/);
 assert.doesNotMatch(wav,/lab-port-worker/);
});
