import {test} from "node:test";
import assert from "node:assert/strict";
import {defineParameter,createParameterBinding} from "./parameter-binding.mjs";
import {mountPercentParameterField} from "./frequency-unit-field.mjs";

class FakeField extends EventTarget{
  constructor(){super();this.value="";this.dataset={};this.selected=0;this.blurred=0;}
  select(){this.selected++;}
  blur(){this.blurred++;this.dispatchEvent(new Event("blur"));}
  trigger(name){this.dispatchEvent(new Event(name));}
}
const createTestField=()=>{
  const field=new FakeField(),changes=[],renders=[];
  const binding=createParameterBinding(defineParameter({
    id:"wet",min:0,max:1,defaultValue:1,units:["percent"],
    rail:{toPosition:v=>v,fromPosition:v=>v},digits:3
  }));
  const refresh=(force=false)=>{
    renders.push(force);
    if(force)field.value=String(binding.display(3));
  };
  const controller=mountPercentParameterField({
    field,binding,refresh,onChanged:(value,previous)=>changes.push([value,previous])
  });
  return {field,binding,changes,renders,controller};
};

test("one typed-percent controller retains canonical precision and notifies exactly once per change",()=>{
  const {field,binding,changes,renders}=createTestField();
  field.trigger("focus");
  assert.equal(field.value,"100");
  assert.equal(field.selected,1);
  field.value="12.345";
  field.trigger("input");
  assert.ok(Math.abs(binding.value-0.12345)<1e-12);
  assert.equal(changes.length,1);
  assert.equal(changes[0][1],1);
  field.trigger("change");
  assert.equal(changes.length,1,"input+change must not commit a second callback");
  assert.ok(renders.length>=2);
  field.value="100";
  field.trigger("input");
  assert.equal(binding.value,1,"100% must map to the canonical endpoint");
  assert.equal(changes.length,2);
  field.value="999";
  field.trigger("input");
  assert.equal(binding.value,1,"invalid >100% must preserve the last valid canonical value");
  assert.equal(field.dataset.invalid,"true");
  assert.equal(changes.length,2);
});

test("invalid and incomplete edits leave the last accepted value untouched and restore on blur",()=>{
  const {field,binding,changes,renders}=createTestField();
  field.value="37.125";field.trigger("input");
  const prior=binding.value;
  for(const invalid of ["", "NaN", "oops"]){
    field.value=invalid;field.trigger("input");
    assert.equal(field.dataset.invalid,"true");
    assert.equal(binding.value,prior);
  }
  assert.equal(changes.length,1);
  field.trigger("blur");
  assert.equal(field.dataset.invalid,undefined);
  assert.equal(field.value,"37.125");
  assert.equal(renders.at(-1),true);
});

test("Enter commits through blur and disposing removes all editor event handlers",()=>{
  const {field,binding,changes,controller}=createTestField();
  field.value="25";field.trigger("input");
  const before=binding.value;
  field.dispatchEvent(new KeyboardEventShim("keydown","Enter"));
  assert.equal(field.blurred,1);
  assert.equal(binding.value,before);
  controller.dispose();
  field.value="42";field.trigger("input");
  assert.equal(binding.value,before,"a disposed editor must never update canonical state");
  assert.equal(changes.length,1);
});

class KeyboardEventShim extends Event{
  constructor(type,key){super(type);this.key=key;}
}
