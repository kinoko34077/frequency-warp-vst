import {test} from "node:test";
import assert from "node:assert/strict";
import {UNIT_REGISTRY, defineParameter, snappedValue, createParameterBinding} from "./parameter-binding.mjs";

const logRail = Object.freeze({
  toPosition:hz=>Math.log2(hz/20)/Math.log2(20000/20),
  fromPosition:p=>20*2**(p*Math.log2(20000/20))
});
const lineRail=(min,max)=>({toPosition:v=>(v-min)/(max-min),fromPosition:p=>min+p*(max-min)});
const pitch=()=>defineParameter({id:"fundamental",min:20,max:20000,defaultValue:440,
  units:["hz","note","percent"],rail:logRail,digits:5,
  snap:{mode:"step",unit:"note",step:1,thresholdPx:8}});

test("unit registry, typed per-parameter allowed units, and invalid declarations",()=>{
  assert.equal(UNIT_REGISTRY.note.dimension,"frequency");
  assert.equal(UNIT_REGISTRY.percent.requiresRail,true);
  assert.deepEqual(pitch().units,["hz","note","percent"]);
  assert.throws(()=>defineParameter({id:"invert",min:0,max:1,defaultValue:0.5,
    units:["hz"],rail:lineRail(0,1)}),RangeError);
  assert.throws(()=>defineParameter({id:"low",min:20,max:20000,defaultValue:100,
    units:["hz","percent"]}),RangeError);
  assert.throws(()=>defineParameter({id:"low",min:20000,max:20,defaultValue:100,
    units:["hz"],rail:logRail}),RangeError);
  assert.throws(()=>defineParameter({id:"fundamental",min:20,max:20000,defaultValue:100,
    units:["hz","note"],rail:logRail,snap:{mode:"step",unit:"cents",step:1}}),RangeError);
});

test("switching views does not change the canonical value or emit DSP callbacks",()=>{
  const changes=[];
  const p=createParameterBinding(pitch(),{initialValue:443.123456789,onChange:e=>changes.push(e)});
  const initial=p.value;
  assert.equal(p.selectUnit("note"),"note");
  assert.match(p.display(),/^[A-G]/);
  p.selectUnit("percent");
  assert.ok(Math.abs(p.display()-100*logRail.toPosition(initial))<.00001);
  p.selectUnit("hz");
  assert.equal(p.value,initial);
  assert.equal(changes.length,0);
  assert.throws(()=>p.selectUnit("cents"),RangeError);
});

test("nonlinear rail percentage uses actual transfer, not percentage of Hz",()=>{
  const p=createParameterBinding(pitch(),{initialUnit:"percent"});
  p.setView("50%");
  assert.ok(Math.abs(p.value-Math.sqrt(20*20000))<1e-8);
  assert.equal(p.display(),50);
  assert.throws(()=>p.setView("101%"),RangeError);
  assert.throws(()=>p.setView(""),RangeError);
});

test("0-Hz pivot is valid canonically but incompatible with note formatting",()=>{
  const zeroRail={toPosition:v=>v===0?0:0.1+0.9*Math.log(v/.001)/Math.log(20000/.001),
    fromPosition:t=>t===0?0:.001*(20000/.001)**((t-.1)/.9)};
  const desc=defineParameter({id:"axis-pivot",min:0,max:20000,defaultValue:0,
    units:["hz","note","percent"],rail:zeroRail});
  const p=createParameterBinding(desc);
  assert.equal(p.value,0);
  assert.throws(()=>{p.selectUnit("note");p.display();},RangeError);
  assert.equal(p.value,0);
  p.selectUnit("hz");
  assert.equal(p.display(),0);
  assert.throws(()=>p.setView("xyz",{unit:"note",overflow:"reject"}),RangeError);
});

test("note+cents parses without rounding canonical state; overflow is explicit",()=>{
  const p=createParameterBinding(pitch());
  p.setView("A4+25c",{unit:"note"});
  const expected=440*2**(25/1200);
  assert.ok(Math.abs(p.value-expected)<1e-10);
  p.setView("200000 Hz",{overflow:"clamp"});
  assert.equal(p.value,20000);
  assert.throws(()=>p.setView("200000",{overflow:"reject"}),RangeError);
  assert.equal(p.value,20000);
  assert.throws(()=>p.setView("xyz"),RangeError);
  assert.equal(p.value,20000);
});

test("snap selects closest actual rail-pixel semitone, not a numeric Hz interval",()=>{
  const desc=pitch();
  const near=440*2**(5/1200); // 5 cents away
  assert.equal(snappedValue(desc,near,{railPixels:350}),440);
  assert.equal(snappedValue(desc,near,{railPixels:100000}),near);
  assert.equal(snappedValue(desc,near,{origin:"typed",railPixels:350}),near);
  assert.throws(()=>snappedValue(desc,near,{railPixels:0}),RangeError);
  const events=[];
  const p=createParameterBinding(desc,{onChange:e=>events.push(e)});
  p.setCanonical(near,{origin:"slider",snap:true,railPixels:350});
  assert.equal(p.value,440);
  assert.equal(events.length,0); // same canonical as initial default
  p.setCanonical(near,{origin:"typed"});
  assert.equal(p.value,near);
  assert.equal(events.length,1);
  assert.equal(events[0].origin,"typed");
});

test("target snap, linked silent derivation, reset and single user transaction",()=>{
  const desc=defineParameter({id:"axis-slope",min:-4,max:4,defaultValue:1,
    units:["ratio","percent"],rail:lineRail(-4,4),
    snap:{mode:"targets",unit:"ratio",targets:[-1,0,1],thresholdPx:10}});
  const ev=[];
  const p=createParameterBinding(desc,{onChange:e=>ev.push(e)});
  p.setPosition((.03+4)/8,{railPixels:350});
  assert.equal(p.value,0);
  assert.equal(ev.length,1);
  p.setCanonical(1.2,{notify:false});
  assert.equal(ev.length,1);
  p.reset();
  assert.equal(p.value,1);
  assert.equal(ev.length,2);
  assert.equal(p.display(),1);
});

test("ratio/semitones/cents and display rounding preserve canonical state",()=>{
  const desc=defineParameter({id:"pitch-ratio",min:.25,max:4,defaultValue:1,
    units:["ratio","semitones","cents","percent"],rail:{
      toPosition:v=>Math.log2(v/.25)/4,
      fromPosition:t=>.25*2**(4*t)
    }});
  const p=createParameterBinding(desc);
  p.setView("700",{unit:"cents"});
  assert.ok(Math.abs(p.value-2**(7/12))<1e-12);
  p.selectUnit("semitones");
  assert.equal(p.display(),7);
  const v=p.value;
  p.selectUnit("ratio");p.display(2);
  assert.equal(p.value,v);
});

test("reentrant user callbacks fail rather than recursively rescheduling",()=>{
  let binding;
  binding=createParameterBinding(pitch(),{onChange:()=>binding.setCanonical(660)});
  assert.throws(()=>binding.setCanonical(442),/reentrant/);
  assert.equal(binding.value,442);
});

test("Wet M3 fraction: typed precision, invalid retention, coarse proxy and silent reset",()=>{
  const events=[];
  const descriptor=defineParameter({id:"wet",min:0,max:1,defaultValue:1,
    units:["percent"],rail:lineRail(0,1),digits:3});
  const wet=createParameterBinding(descriptor,{onChange:e=>events.push(e)});
  wet.setView("12.345",{unit:"percent",notify:false});
  assert.ok(Math.abs(wet.value-.12345)<1e-12);
  assert.equal(wet.display(),12.345);
  const before=wet.value;
  for(const text of ["","oops","NaN"]){
    assert.throws(()=>wet.setView(text,{unit:"percent",notify:false}));
    assert.equal(wet.value,before);
  }
  assert.throws(()=>wet.setView("101",{unit:"percent",notify:false}));
  assert.equal(wet.value,before);
  for(const [pos,display] of [[0,0],[.5,50],[1,100]]){
    wet.setPosition(pos,{snap:false,notify:false});
    assert.equal(wet.value,pos);
    assert.equal(wet.display(),display);
  }
  wet.setCanonical(.12345,{notify:false});
  assert.equal(wet.value,.12345);
  wet.reset({notify:false});
  assert.equal(wet.value,1);
  assert.equal(events.length,0,"silent A/B and reset cause no second DSP callback");
});

test("A reverb M3: 0.001% typed step independent of 1% gesture proxy",()=>{
  const descriptor=defineParameter({id:"a-reverb",min:0,max:1,defaultValue:0,
    units:["percent"],rail:lineRail(0,1),digits:3});
  const notifications=[];
  const p=createParameterBinding(descriptor,{onChange:event=>notifications.push(event)});
  p.setView("33.333",{unit:"percent",notify:false});
  assert.ok(Math.abs(p.value-.33333)<1e-12);
  assert.equal(p.display(),33.333);
  assert.equal(Math.round(p.value*100),33,"coarse slider is only a projection");
  for(const bad of ["","bad","NaN"]){
    assert.throws(()=>p.setView(bad,{notify:false}),RangeError);
    assert.ok(Math.abs(p.value-.33333)<1e-12);
  }
  p.setPosition(.75,{notify:false,snap:false});
  assert.equal(p.value,.75);
  p.setCanonical(.33333,{notify:false}); // frozen A/B direct owner restore
  assert.equal(p.display(),33.333);
  p.reset({notify:false});
  assert.equal(p.value,0);
  assert.deepEqual(notifications,[]);
});

test("reflection synthesis gain M3: 0.001% typing, whole-percent thumb, A/B and reset",()=>{
  const changes=[];
  const p=createParameterBinding(defineParameter({
    id:"zero-reflect",min:0,max:1,defaultValue:1,units:["percent"],
    rail:lineRail(0,1),digits:3
  }),{onChange:e=>changes.push(e)});
  p.setView("37.125",{unit:"percent",notify:false});
  assert.ok(Math.abs(p.value-.37125)<1e-12);
  assert.equal(p.display(),37.125);
  assert.equal(Math.round(p.value*100),37,"dual thumb is a coarse display proxy only");
  const accepted=p.value;
  for(const invalid of ["","oops","NaN"]){
    assert.throws(()=>p.setView(invalid,{unit:"percent",notify:false}),RangeError);
    assert.equal(p.value,accepted);
  }
  p.setCanonical(.75,{notify:false});
  const b=p.value;
  p.setCanonical(accepted,{notify:false});
  assert.equal(p.value,accepted);
  p.setCanonical(b,{notify:false});
  assert.equal(p.value,.75);
  p.setPosition(0,{snap:false,notify:false});
  assert.equal(p.value,0);
  p.setPosition(1,{snap:false,notify:false});
  assert.equal(p.value,1);
  p.reset({notify:false});
  assert.equal(p.value,1);
  assert.deepEqual(changes,[],"silent restore must not duplicate DSP notifications");
});

test("reflection decay M3: precise percent, whole-percent thumb, A/B and zero reset",()=>{
  const events=[];
  const p=createParameterBinding(defineParameter({
    id:"zero-decay",min:0,max:1,defaultValue:0,units:["percent"],
    rail:lineRail(0,1),digits:3
  }),{onChange:e=>events.push(e)});
  p.setView("12.345",{unit:"percent",notify:false});
  assert.ok(Math.abs(p.value-.12345)<1e-12);
  assert.equal(p.display(),12.345);
  assert.equal(Math.round(p.value*100),12);
  const a=p.value;
  for(const bad of ["","NaN","bad"]){
    assert.throws(()=>p.setView(bad,{notify:false}),RangeError);
    assert.equal(p.value,a);
  }
  p.setCanonical(.8,{notify:false});
  const b=p.value;
  p.setCanonical(a,{notify:false});assert.equal(p.value,.12345);
  p.setCanonical(b,{notify:false});assert.equal(p.value,.8);
  p.setPosition(0,{snap:false,notify:false});assert.equal(p.value,0);
  p.setPosition(1,{snap:false,notify:false});assert.equal(p.value,1);
  p.reset({notify:false});assert.equal(p.value,0);
  assert.deepEqual(events,[],"silent A/B and reset must not duplicate DSP callbacks");
});

test("inversion M3 fraction: typed precision, .005 shape rail, A/B and zero reset",()=>{
  const changes=[];
  const p=createParameterBinding(defineParameter({
    id:"invert",min:0,max:1,defaultValue:0,units:["percent"],
    rail:lineRail(0,1),digits:3
  }),{onChange:e=>changes.push(e)});
  p.setView("34.567",{unit:"percent",notify:false});
  assert.ok(Math.abs(p.value-.34567)<1e-12);
  assert.equal(p.display(),34.567);
  assert.ok(Math.abs(Math.round(p.value/.005)*.005-.345)<1e-12);
  const a=p.value;
  for(const bad of ["","NaN","bad"]){
    assert.throws(()=>p.setView(bad,{notify:false}),RangeError);
    assert.equal(p.value,a);
  }
  p.setCanonical(.7,{notify:false});
  p.setCanonical(a,{notify:false});assert.equal(p.value,a);
  p.setPosition(0,{snap:false,notify:false});assert.equal(p.value,0);
  p.setPosition(1,{snap:false,notify:false});assert.equal(p.value,1);
  p.reset({notify:false});assert.equal(p.value,0);
  assert.deepEqual(changes,[],"silent A/B and reset must not duplicate DSP callbacks");
});
