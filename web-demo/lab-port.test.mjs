import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {CYCLE_CHOICES,cycleFromPosition,modelControls} from './lab-port.mjs';
import {PERIOD_CYCLE_CHOICES,theoreticalWindow} from './lab-model/period-joint.mjs';
import {renderPCM} from './lab-model/lab-dsp.mjs';
const sr=16000;
function tone(){
 const data=new Float32Array(sr*.6);
 for(let i=0;i<data.length;i++){
  const t=i/sr;
  data[i]=.20*Math.cos(2*Math.PI*347.137*t+.17)+.11*Math.cos(2*Math.PI*813.283*t+.7);
 }
 return data;
}
test('ported exact frequency-specific K slider and mathematical K/f windows retain all options',()=>{
 assert.deepEqual(CYCLE_CHOICES,[.5,1,2,4,8,16,32]);
 assert.deepEqual(PERIOD_CYCLE_CHOICES,CYCLE_CHOICES);
 for(let i=-1;i<=5;i++){
  const k=cycleFromPosition(i);
  assert.ok(Math.abs(theoreticalWindow(347.137,k)-k/347.137)<1e-14);
 }
 assert.equal(cycleFromPosition(3),8);
});
test('all four backend settings stay selectable and preserve expected source DSP parameter values',()=>{
 for(const backend of ['pv','wsola','dual','am'])for(const individual of [false,true]){
  const ctl=modelControls({backend,individual,cycles:2,short:512,long:2048,speed:.8,pitch:3});
  assert.equal(ctl.model,individual?'period-joint':backend);
  assert.equal(ctl.jointBackend,individual?backend:null);
  assert.equal(ctl.periodCycles,2);
  assert.equal(ctl.shortFftSize,512);
  assert.equal(ctl.longFftSize,2048);
  const rendered=renderPCM({channels:[tone()],sampleRate:sr,...ctl});
  assert.equal(rendered.channels[0].length,Math.round(sr*.6/.8));
  assert.ok(rendered.channels[0].every(Number.isFinite));
 }
});
test('control rejects unsupported spectral window pair rather than silently clamping',()=>{
 const c={individual:true,backend:'dual',cycles:8,short:2048,long:1024,speed:1,pitch:0};
 assert.throws(()=>modelControls(c),/短窓/);
 assert.throws(()=>modelControls({...c,short:256,cycles:.75}),/不正な/);
 assert.throws(()=>modelControls({...c,short:256,backend:'live'}),/不正な/);
});
test('ported backend neutral and legacy source original renderer are bit-identical without individual option',()=>{
 const input=tone();
 for(const backend of ['pv','wsola','dual','am']){
  const ctl=modelControls({individual:false,backend,cycles:8,short:512,long:2048,speed:1,pitch:0});
  assert.deepEqual(renderPCM({channels:[input],sampleRate:sr,...ctl}).channels[0],input);
 }
});
test('user-visible Lab opt-in controls and original Rust engine selector coexist unchanged',()=>{
 const html=readFileSync(new URL('./index.html',import.meta.url),'utf8');
 const app=readFileSync(new URL('./app.mjs',import.meta.url),'utf8');
 const worker=readFileSync(new URL('./lab-port-worker.mjs',import.meta.url),'utf8');
 for(const id of ['lab-port-backend','lab-port-individual','lab-port-apply-warp','lab-port-cycles','lab-port-short',
 'lab-port-long','lab-port-speed','lab-port-pitch','lab-port-preview','lab-port-stop'])
  assert.match(html,new RegExp('id="'+id+'"'));
 assert.match(app,/mountLabComparison/);
 assert.match(app,/AudioWorkletNode\(ctx,"frequency-warp-rust"/);
 assert.match(app,/controls\.wet\.addEventListener/);
 assert.match(worker,/renderPCM\(\{channels,sampleRate,sourceStartSeconds,\.\.\.options\}\)/);
 assert.match(html,/Frequency Warpの非線形写像・反転・曲率・移動は、この試聴にはまだ適用しません/);
});

test('sequential native Rust Warp stage is opt-in and routed through the existing actual WASM Worker',()=>{
 const app=readFileSync(new URL('./app.mjs',import.meta.url),'utf8');
 const ui=readFileSync(new URL('./lab-port.mjs',import.meta.url),'utf8');
 const html=readFileSync(new URL('./index.html',import.meta.url),'utf8');
 assert.match(app,/getWarpSettings:\(\)=>prepareStreamSettings/);
 assert.match(ui,/new URL\('\.\/processor\.worker\.mjs',import\.meta\.url\)/);
 assert.match(ui,/type:'process',channels:copies/);
 assert.match(ui,/settings:checked\.settings/);
 assert.match(ui,/const wet=Math\.max\(0,Math\.min\(1,Number\(checked\.settings\.wet\)\)\)/);
 assert.match(ui,/launchLab\(combined,0\)/);
 assert.match(ui,/if\(!warp\.checked\)/);
 assert.match(html,/現在のFrequency Warp変換を先に適用/);
});
