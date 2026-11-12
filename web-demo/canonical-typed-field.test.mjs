/** #355 G3: reuse #79 canonical binding without a second typed-input controller. */
import {test} from "node:test";
import assert from "node:assert/strict";
import {defineParameter,createParameterBinding} from "./parameter-binding.mjs";
import {parseView} from "./parameter-units.mjs";
import {mountCanonicalTypedField} from "./frequency-unit-field.mjs";

class FakeField extends EventTarget {
  constructor(){
    super();this.value="";this.attrs=new Map();this.selections=0;
    this.ownerDocument={activeElement:null};
  }
  setAttribute(k,v){this.attrs.set(k,String(v));}
  getAttribute(k){return this.attrs.get(k);}
  select(){this.selections++;}
  focus(){this.ownerDocument.activeElement=this;this.dispatchEvent(new Event("focus"));}
  blur(){this.ownerDocument.activeElement=null;this.dispatchEvent(new Event("blur"));}
  send(event){this.dispatchEvent(new Event(event));}
}
function fixture(){
  const field=new FakeField(),changed=[],maxTyped=20000;
  const descriptor=defineParameter({
    id:"virtual-root-h",
    min:Number.MIN_VALUE,max:Number.MAX_VALUE,defaultValue:87.5,
    units:["hz","note","percent"],digits:2,
    rail:{toPosition:x=>(x-1)/199,fromPosition:t=>1+t*199}
  });
  const binding=createParameterBinding(descriptor);
  const format=()=>String(binding.display(1));
  const typed=mountCanonicalTypedField({
    field,binding,displayValue:format,
    focusValue:()=>binding.unit==="note"?null:
      binding.unit==="hz"?String(binding.value):String(binding.display(12)),
    parseCanonical:raw=>{
      if(!String(raw).trim())return null;
      try{
        const n=parseView(raw,binding.unit,{id:descriptor.id,
          digits:2,fromRail:descriptor.rail.fromPosition});
        return Number.isFinite(n)&&n>0&&n<=maxTyped?n:null;
      }catch{return null;}
    },
    onValueChange:(v,prev)=>changed.push({v,prev})
  });
  field.value=format();
  return {field,binding,changed,typed};
}

test("typed F/H view owns one focus/input/change/blur transaction, not parallel Hz state",()=>{
  const {field,binding,changed,typed}=fixture();
  field.focus();
  assert.equal(field.selections,1,"Hz gives editable exact value when focused");
  field.value="93.125";
  field.send("input");
  assert.equal(binding.value,93.125);
  assert.equal(changed.length,1);
  field.send("change");
  assert.equal(changed.length,1,"native input+change must not publish twice");
  field.value="";
  field.send("input");
  assert.equal(field.getAttribute("aria-invalid"),"true");
  assert.equal(binding.value,93.125,"empty draft does not erase accepted canonical");
  field.blur();
  assert.equal(field.value,String(binding.display(1)));
  assert.equal(field.getAttribute("aria-invalid"),"false");
  field.value="99999";
  field.send("input");
  assert.equal(binding.value,93.125,"consumer's typed ceiling is not relaxed by shared UI adapter");
  assert.equal(changed.length,1);
  binding.selectUnit("percent");
  const previous=binding.value;
  field.value="50";
  field.send("input");
  assert.equal(binding.value,100.5,"physical rail percent has its existing nonlinear codec owner");
  assert.equal(changed.length,2);
  assert.notEqual(binding.value,previous);
  field.focus();assert.ok(field.selections>=2);
  const before=binding.value;
  typed.dispose();
  field.value="75";field.send("input");
  assert.equal(binding.value,before,"disposed adapter cannot mutate the canonical value");
  assert.equal(changed.length,2);
});

test("note typed entry changes canonical Hz without forcing gesture snap or unit-only DSP",()=>{
  const {field,binding,changed,typed}=fixture();
  binding.selectUnit("note");
  field.value="A4";
  field.send("input");
  assert.ok(Math.abs(binding.value-440)<1e-8);
  assert.equal(changed.length,1);
  const before=binding.value;
  binding.selectUnit("hz");
  assert.equal(binding.value,before,"unit change is presentation-only");
  field.value="not-a-number";
  field.send("input");
  assert.equal(binding.value,before);
  assert.equal(field.getAttribute("aria-invalid"),"true");
  field.blur();
  assert.equal(field.getAttribute("aria-invalid"),"false");
  typed.dispose();
});
