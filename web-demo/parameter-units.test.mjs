import {test} from "node:test";
import assert from "node:assert/strict";
import {compatibleUnits,noteCentsToHz,hzToNoteCents,parseView,formatView,
 semitonesToRatio,ratioToSemitones} from "./parameter-units.mjs";
test("canonical Hz <-> note+cents uses a stable A4 reference and direct decimal cents",()=>{
 assert.equal(noteCentsToHz("A4"),440);
 assert.ok(Math.abs(noteCentsToHz("A4+100c")-466.1637615180899)<1e-7);
 assert.ok(Math.abs(noteCentsToHz("Bb3")-233.081880759)<1e-7);
 assert.equal(hzToNoteCents(440),"A4");
 for(const hz of [.001,20,87.5,350,440,2000,20000]){
   const pitch=hzToNoteCents(hz,5),roundtrip=noteCentsToHz(pitch);
   assert.ok(Math.abs(1200*Math.log2(roundtrip/hz))<.00006,
     "pitch conversion drift: "+JSON.stringify({hz,pitch,roundtrip}));
 }
 assert.throws(()=>noteCentsToHz("xyz"),RangeError);
 assert.throws(()=>hzToNoteCents(0),RangeError);
});
test("display units are typed and never change the canonical DSP number",()=>{
 assert.deepEqual(compatibleUnits("low"),["hz","note","percent"]);
 assert.deepEqual(compatibleUnits("invert"),["percent"]);
 assert.deepEqual(compatibleUnits("pitch-ratio"),["ratio","semitones","cents","percent"]);
 assert.deepEqual(compatibleUnits("axis-shift"),["coordinate","percent"]);
 assert.ok(Math.abs(semitonesToRatio(12)-2)<1e-12);
 assert.ok(Math.abs(ratioToSemitones(2)-12)<1e-12);
 assert.equal(parseView("A4+50c","note",{id:"low"}),noteCentsToHz("A4+50c"));
 assert.throws(()=>parseView("500","hz",{id:"invert"}),RangeError);
 assert.throws(()=>parseView("C4","note",{id:"axis-shift"}),RangeError);
 assert.equal(parseView("50%","percent",{id:"axis-slope",fromRail:t=>-4+8*t}),0);
 assert.equal(formatView(0,"percent",{id:"axis-slope",toRail:v=>(v+4)/8}),50);
 assert.equal(formatView(2,"semitones",{id:"pitch-ratio"}),12);
 assert.throws(()=>parseView("50","percent",{id:"low"}),RangeError,
   "percent must not silently mean a linear share of Hz");
});
