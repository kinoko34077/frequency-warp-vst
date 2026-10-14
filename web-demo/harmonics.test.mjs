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

test("20 kHz view spans full range while retaining square-axis ideal map",()=>{
 const cfg={low:20,high:20000,curvature:1,invert:0,mode:"fold-h",outside:"pass",
   axisPivot:0,axisSlope:2,axisReference:350,axisShift:0,sampleRate:48000};
 const twice=(f,pivot,curvature,shift,slope)=>pivot+slope*(f-pivot);
 const points=graphSegments(cfg,(f)=>f,twice,20000);
 assert.equal(points[0].f,20);
 assert.equal(points.at(-1).f,20000);
 const at500=points.find(pt=>Math.abs(pt.f-500)<25);
 assert.ok(Math.abs(at500.outputs[0]-2*at500.f)<1e-9);
});

test("display sampling follows logarithmic 20-20k frequency view instead of missing bass",()=>{
 const cfg={low:20,high:20000,curvature:1,invert:0,mode:"blend",
   outside:"pass",axisPivot:350,axisSlope:1,axisReference:350,axisShift:0,
   sampleRate:48000};
 const linear=graphSegments(cfg,f=>f,(f)=>f,20000);
 const logarithmic=graphSegments(cfg,f=>f,(f)=>f,20000,
   t=>20*Math.pow(1000,t));
 const bass=rows=>rows.filter(pt=>pt.f>20&&pt.f<100).length;
 assert.ok(bass(linear)<5,"linear graph should show sparse bass samples");
 assert.ok(bass(logarithmic)>100,"log graph must sample bass densely");
 assert.equal(logarithmic[0].f,20);
 assert.equal(logarithmic.at(-1).f,20000);
});
test("graph matches Rust signed zero handling AFTER rational layout",()=>{
 const cfg={low:100,high:1000,curvature:1,invert:0,mode:"blend",
   outside:"pass",axisReference:350,axisPivot:350,axisSlope:1,
   axisShift:-2,rationalEnabled:true,pitchRatio:1,shiftHz:-700,
   zeroMode:0,sampleRate:48000,qualityIndex:0};
 // At 500Hz, rational stage yields -200Hz. The Rust streaming engine does
 // not subsequently translate the negative value; Reflect yields +200Hz.
 const result=graphSegments(cfg,f=>f,(f,pivot,p,shift,slope)=>f+shift*350,2000)
   .find(row=>Math.abs(row.f-500)<2);
 assert.ok(result);
 assert.ok(Math.abs(result.outputs[0]-200)<2);
});
test("Fade near zero follows the selected Rust FFT window, not a fixed 1024",()=>{
 const cfg={low:20,high:2000,curvature:1,invert:0,mode:"blend",
   outside:"pass",axisReference:350,axisPivot:350,axisSlope:1,axisShift:0,
   rationalEnabled:true,pitchRatio:1,shiftHz:-513,zeroMode:2,
   sampleRate:48000};
 const f=500;
 // Negative target -13Hz; 1024-window step=46.875 keeps it, while
 // 4096-window step=11.719 discards it.
 const one=graphSegments({...cfg,qualityIndex:0},x=>x,(x)=>x,2000);
 const three=graphSegments({...cfg,qualityIndex:2},x=>x,(x)=>x,2000);
 const near=rows=>rows.find(row=>Math.abs(row.f-f)<2);
 assert.ok(near(one)?.outputs[0]>0);
 assert.equal(near(three)?.outputs.length,0);
});
