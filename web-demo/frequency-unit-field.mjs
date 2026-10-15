/** #79 M1: one-control Web adapter on the declarative canonical binding.
 * Unit-selection is display-only; value commits are single sourced.
 * Reusable for later frequency controls, without rewriting old DOM listeners.
 */
import {createParameterBinding} from "./parameter-binding.mjs";

export function mountFrequencyUnitField({descriptor,field,select,snapToggle,slider,railRoot,
  initialValue=descriptor.defaultValue,getDigits=()=>descriptor.digits,onValueChange=()=>{}}) {
  if (![field,select,snapToggle,slider,railRoot].every(Boolean) ||
      typeof onValueChange !== "function")
    throw new TypeError("frequency unit field controls are required");
  const binding=createParameterBinding(descriptor,{initialValue});
  const position=()=>descriptor.rail.toPosition(binding.value);
  const coarseSync=()=>{slider.value=String(Math.round(position()*
    (Number(slider.max)-Number(slider.min))+Number(slider.min)));};
  let lastRendered="";
  const display=(force=false)=>{
    // A 0-Hz pivot has no musical-note spelling. Recover into a valid
    // physical view instead of throwing and breaking live controls.
    if(binding.value<=0&&binding.unit==="note"){
      binding.selectUnit("hz");select.value="hz";
    }
    if(force || field.ownerDocument.activeElement!==field){
      field.value=String(binding.display(getDigits()));
      lastRendered=field.value;
    }
  };
  let dirty=false;
  const commitTyped=()=>{
    if(!dirty)return false;
    const old=binding.value;
    try {
      // Clamp only on valid, complete input. Invalid intermediate note spellings
      // do not destroy the last accepted DSP value.
      binding.setView(field.value,{origin:"typed",overflow:"clamp"});
    }catch{return false;}
    dirty=false;
    if(!Object.is(old,binding.value)){
      coarseSync();
      onValueChange(binding.value,"typed");
    }
    return true;
  };
  field.addEventListener("focus",()=>{
    if(binding.unit==="hz")field.value=String(binding.value);
    else field.value=String(binding.display(8));
    lastRendered=field.value;
    field.select();
  });
  field.addEventListener("input",()=>{dirty=true;commitTyped();});
  field.addEventListener("change",()=>{
    // A normal browser emits input then change; programmatic keyboard
    // commits and existing Web regression clients may emit change only.
    // Never reparse a merely formatted unchanged field (precision loss).
    if(dirty || field.value!==lastRendered){dirty=true;commitTyped();}
    dirty=false;display(true);
  });
  field.addEventListener("blur",()=>{
    if(dirty)commitTyped();
    dirty=false;display(true);
  });
  field.addEventListener("keydown",event=>{
    if(event.key==="Enter")field.blur();
  });
  select.addEventListener("change",()=>{
    if(select.value==="note" && binding.value<=0){
      select.value="hz"; // 0Hz is undefined as musical pitch
    }
    binding.selectUnit(select.value);
    dirty=false;
    display(true); // unit notation must never change DSP value
  });
  const fromSlider=()=>{
    const old=binding.value;
    const normalized=(Number(slider.value)-Number(slider.min))/
      (Number(slider.max)-Number(slider.min));
    binding.setPosition(normalized,{
      origin:"slider",
      snap:snapToggle.checked,
      railPixels:Math.max(1,railRoot.getBoundingClientRect().width)
    });
    coarseSync();
    display();
    if(!Object.is(old,binding.value))onValueChange(binding.value,"slider");
  };
  coarseSync();
  display(true);
  return Object.freeze({
    get value(){return binding.value;},
    get unit(){return binding.unit;},
    fromSlider,
    refresh:()=>display(),
    setCanonical(value){
      binding.setCanonical(value,{origin:"constraint",notify:false});
      coarseSync();
      display();
    },
    reset(){
      binding.reset({notify:false});
      select.value=descriptor.units[0];
      binding.selectUnit(select.value);
      snapToggle.checked=false;
      dirty=false;
      coarseSync();
      display(true);
    }
  });
}
