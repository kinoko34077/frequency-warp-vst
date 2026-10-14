import {test} from "node:test";
import assert from "node:assert/strict";
import {canExportChannels,MAX_EXPORT_SAMPLES} from "./export-policy.mjs";
test("preflight 40M sample cap rejects without requiring allocations",()=>{
  assert.equal(MAX_EXPORT_SAMPLES,40_000_000);
  assert.equal(canExportChannels([{length:20_000_000},{length:20_000_000}]),true);
  assert.equal(canExportChannels([{length:20_000_001},{length:20_000_000}]),false);
  assert.equal(canExportChannels([{length:40_000_001}]),false);
  assert.equal(canExportChannels([new Float32Array(128)]),true);
  assert.equal(canExportChannels([]),false);
  assert.equal(canExportChannels([{length:Infinity}]),false);
});
