import {test} from "node:test";
import assert from "node:assert/strict";
import {freezeExportIdentity,matchesExportIdentity} from "./export-identity.mjs";

test("only exact source and full frozen effective DSP packet can download",()=>{
  const current={sampleRate:44100,low:20,high:16000,
    mode:"fold-h",ringEnabled:true,axisShift:.123456789};
  const saved=freezeExportIdentity(7,current);
  assert.ok(Object.isFrozen(saved.settings));
  current.low=30;
  assert.equal(saved.settings.low,20);
  assert.equal(matchesExportIdentity(saved,7,current),false);
  assert.equal(matchesExportIdentity(saved,8,{...saved.settings}),false);
  // Wet is a download-time mix, not a DSP re-render parameter.
  for(const wet of [0,.5,1]){
    assert.ok(wet>=0&&wet<=1);
    assert.equal(matchesExportIdentity(saved,7,{...saved.settings}),true);
  }
  assert.equal(matchesExportIdentity(saved,7,{...saved.settings,axisShift:.123456788}),false);
  assert.equal(matchesExportIdentity(saved,7,{...saved.settings}),true);
  assert.equal(matchesExportIdentity(saved,7,{...saved.settings,other:1}),false);
});
test("malformed source and unsupported settings fail closed",()=>{
  assert.throws(()=>freezeExportIdentity(0,{low:20}),/Invalid export identity/);
  assert.throws(()=>freezeExportIdentity(1,{low:NaN}),/Non-scalar export setting/);
  assert.throws(()=>freezeExportIdentity(1,{nested:{unsafe:true}}),/Non-scalar export setting/);
  assert.equal(matchesExportIdentity(null,1,{low:20}),false);
});
