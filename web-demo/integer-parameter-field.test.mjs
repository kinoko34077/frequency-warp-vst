import {test} from "node:test";
import assert from "node:assert/strict";
import {defineParameter} from "./parameter-binding.mjs";
import {mountIntegerParameterField} from "./frequency-unit-field.mjs";

class FakeControl extends EventTarget{
  constructor(value){super();this.value=String(value);this.dataset={};this.selected=0;}
  select(){this.selected++;}
  blur(){this.dispatchEvent(new Event("blur"));}
  dispatch(type){this.dispatchEvent(new Event(type));}
}

function fixture(id="denominator",min=1,max=64,defaultValue=4){
  const field=new FakeControl(defaultValue),slider=new FakeControl(defaultValue),events=[];
  const descriptor=defineParameter({id,min,max,defaultValue,units:["integer"],digits:0,
    rail:{toPosition:v=>(v-min)/(max-min),fromPosition:t=>min+t*(max-min)}});
  const controller=mountIntegerParameterField({
    descriptor,field,slider,onValueChange:(value,previous,origin)=>
      events.push({value,previous,origin})
  });
  return {field,slider,events,controller};
}

test("integer field uses exactly one canonical owner during native input/change",()=>{
  const {field,slider,events,controller}=fixture();
  field.dispatch("focus");assert.equal(field.selected,1);
  field.value="7";field.dispatch("input");
  assert.equal(controller.value,7);assert.equal(slider.value,"7");
  assert.equal(events.length,1);
  field.dispatch("change");
  assert.equal(events.length,1,"input then change must not notify twice");
  field.value="";field.dispatch("input");
  assert.equal(controller.value,7,"empty number editor cannot change harmonic state");
  assert.equal(slider.value,"7");
  field.blur();assert.equal(field.value,"7");
  assert.equal(events.length,1);
  field.value="99";field.dispatch("change");
  assert.equal(controller.value,64,"out-of-bounds typed integer clamps once");
  assert.equal(field.value,"64");
  assert.equal(events.length,2);
  slider.value="8";slider.dispatch("input");
  assert.equal(controller.value,8);assert.equal(field.value,"8");
  assert.equal(events.length,3);
  slider.dispatch("input");assert.equal(events.length,3);
});

test("signed numerator, harmonic index and snapshots restore silently",()=>{
  const n=fixture("numerator",-128,128,-3);
  n.field.value="-19";n.field.dispatch("input");
  assert.equal(n.controller.value,-19);
  n.field.value="-19.7";n.field.dispatch("input");
  assert.equal(n.controller.value,-20,"integer canonical state rounds typed count");
  n.controller.setCanonical(-3);
  assert.equal(n.controller.value,-3);assert.equal(n.slider.value,"-3");
  assert.equal(n.field.value,"-3");
  assert.equal(n.events.length,2,"restore does not publish separate audio events");
  assert.throws(()=>n.controller.setCanonical(1.5),RangeError);
  const q=fixture("harmonic-index",1,32,1);
  q.slider.value="24";q.slider.dispatch("input");
  assert.equal(q.controller.value,24);
  q.controller.reset();
  assert.equal(q.controller.value,1);
  assert.equal(q.slider.value,"1");
  q.controller.dispose();
  q.field.value="17";q.field.dispatch("input");
  assert.equal(q.controller.value,1,"disposed adapter cannot modify canonical values");
});
