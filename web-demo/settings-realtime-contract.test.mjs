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
