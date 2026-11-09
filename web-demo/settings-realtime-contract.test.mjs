import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const read=p=>readFileSync(new URL(p,import.meta.url),'utf8');
test('Audio Lab migration cannot substitute standalone audition for realtime Settings processing',()=>{
 const html=read('./index.html'),app=read('./app.mjs');
 assert.doesNotMatch(html,/id="lab-port-panel"/);
 assert.doesNotMatch(html,/id="lab-port-preview"/);
 assert.doesNotMatch(app,/mountLabComparison|labCompare|lab-port-worker/);
 assert.match(html,/<dialog id="settings-dialog"/);
 assert.match(html,/<select id="engine">/);
 assert.match(app,/frequency-warp-rust/);
 assert.match(app,/AudioWorkletNode/);
 assert.match(app,/controls\.wet\.addEventListener\("click"/);
});

test('Settings offer only implemented engines and name the actual reset scope',()=>{
 const html=read('./index.html');
 const engine=html.match(/<select id="engine">([\s\S]*?)<\/select>/);
 assert.ok(engine,"the engine selector remains available");
 const options=[...engine[1].matchAll(/<option([^>]*)>([\s\S]*?)<\/option>/g)];
 assert.deepEqual(options.map(([,attrs])=>/\bvalue="([^"]+)"/.exec(attrs)?.[1]??null),["0","1"],
  "the menu should not expose disabled, unimplemented DSP candidates");
 const reset=html.match(/<button id="settings-reset"[^>]*>([^<]*)<\/button>/);
 assert.equal(reset?.[1],"操作値を初期値に戻す",
  "the label should describe the existing whole-operation reset");
 assert.match(html,/<details id="low-frequency-capability-details"[^>]*>[\s\S]*?<summary>低域の実測範囲<\/summary>[\s\S]*?id="low-frequency-capability-help"/,
  "long PCM measurements should remain available in a labeled disclosure");
 assert.match(html,/<details id="prototype-info"[^>]*>[\s\S]*?<summary>この試作版について<\/summary>[\s\S]*?<details id="developer-tools"[^>]*>[\s\S]*?id="debug-mode"/,
  "developer-only controls should be under the existing prototype disclosure");
});
