import {test} from "node:test";
import assert from "node:assert/strict";
import {deriveHarmonics,graphSegments} from "./harmonics.mjs";
import {mapFrequency} from "./mapping-oracle.test-helper.mjs";

test("Issue16 F=100 -75Hz => virtual root 25Hz and sparse indices 1,5,9...",()=>{
  const v=deriveHarmonics(100,4,-3,1,1,5);
  assert.equal(v.H,25);assert.equal(v.delta,-75);
  assert.deepEqual(v.rows.map(x=>x.translated),[25,125,225,325,425]);
  assert.deepEqual(v.rows.map(x=>x.number),[1,5,9,13,17]);
});
test("Issue16 virtual-root arrival q=1,F=350,m=4 -> 437.5 downfold",()=>{
  const v=deriveHarmonics(350,4,-3,1,1,5);
  assert.equal(v.H,87.5);assert.equal(v.foldShift,437.5);
  assert.deepEqual(v.rows.map(x=>x.reflected),[87.5,262.5,612.5,962.5,1312.5]);
});
test("graph is fixed 20-2000Hz and passes identity outside L/H",()=>{
  const opts={low:250,high:1200,curvature:1,invert:1,mode:"fold-h",
    outside:"pass",engine:0,pitchRatio:1,shiftHz:0,carrierHz:100,zeroMode:0};
  const rows=graphSegments(opts,mapFrequency);
  assert.equal(rows[0].f,20);assert.equal(rows.at(-1).f,2000);
  assert.deepEqual(rows[0].outputs,[20]);
  assert.deepEqual(rows.at(-1).outputs,[2000]);
  const centre=rows.find(p=>p.f>550&&p.f<560);
  assert.ok(centre.inside && Math.abs(centre.outputs[0]-centre.f)>100);
  assert.ok(rows.filter(p=>p.inside).length>100);
  assert.equal(graphSegments({...opts,outside:"kill"},mapFrequency)[0].outputs.length,0);
});
test("ring modulation draws two actual ideal sidebands",()=>{
  const options={low:20,high:2000,curvature:1,invert:1,mode:"fold-h",outside:"pass",
    engine:0,ringEnabled:true,pitchRatio:1,shiftHz:0,carrierHz:300,zeroMode:0};
  const point=graphSegments(options,mapFrequency).find(p=>p.f>495&&p.f<505);
  assert.equal(point.outputs.length,2);
  const mapped=mapFrequency(point.f,20,2000,1,1,"fold-h");
  assert.ok(Math.abs(point.outputs[0]-(mapped+300))<1e-6);
  assert.ok(Math.abs(point.outputs[1]-Math.abs(mapped-300))<1e-6);
  assert.ok(Math.abs(point.outputs[0]-(point.f+300))>100,"Ring chain ignores Warp");
});
