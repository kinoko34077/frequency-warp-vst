/** #79 M1: one-control Web adapter on the declarative canonical binding.
 * Unit-selection is display-only; value commits are single sourced.
 * Reusable for later frequency controls, without rewriting old DOM listeners.
 */
import {createParameterBinding} from "./parameter-binding.mjs";

// Modifier bypass is gesture-scoped; it never changes the saved ON/OFF state.
const held={alt:false,ctrl:false};
if(typeof window!=="undefined"){
  window.addEventListener("keydown",event=>{held.alt=event.altKey;held.ctrl=event.ctrlKey;},true);
  window.addEventListener("keyup",event=>{held.alt=event.altKey;held.ctrl=event.ctrlKey;},true);
  window.addEventListener("blur",()=>{held.alt=false;held.ctrl=false;});
}
// One lightweight transient menu shared by all parameter controls. No HTML
// cloning, state persistence or interference with the actual DSP parameters.
function getSnapMenu(doc){
  let menu=doc.getElementById("fw-unit-snap-menu");
  if(menu)return menu;
  menu=doc.createElement("div");
  menu.id="fw-unit-snap-menu";menu.hidden=true;menu.setAttribute("role","menu");
  const button=doc.createElement("button");
  button.type="button";button.setAttribute("role","menuitemcheckbox");
  menu.append(button);doc.body.append(menu);
  menu._button=button;
  button.addEventListener("click",()=>{
    menu._toggle?.();menu.hidden=true;
  });
  doc.addEventListener("pointerdown",event=>{
    if(!menu.hidden&&!menu.contains(event.target))menu.hidden=true;
  },true);
  doc.addEventListener("keydown",event=>{
    if(event.key==="Escape"&&!menu.hidden){
      menu.hidden=true;event.preventDefault();
    }
  },true);
  return menu;
}
function placeMenu(menu,x,y){
  menu.hidden=false;
  const width=menu.offsetWidth||180,height=menu.offsetHeight||48;
  menu.style.left=Math.max(8,Math.min(window.innerWidth-width-8,x))+"px";
  menu.style.top=Math.max(8,Math.min(window.innerHeight-height-8,y))+"px";
}


export function mountParameterUnitField({descriptor,field,select,slider,railRoot,
  initialValue=descriptor.defaultValue,getDigits=()=>descriptor.digits,onValueChange=()=>{}}) {
  if (![field,select,slider,railRoot].every(Boolean) ||
      typeof onValueChange !== "function")
    throw new TypeError("frequency unit field controls are required");
  const binding=createParameterBinding(descriptor,{initialValue});
  let unitButtons=null;
  const position=()=>descriptor.rail.toPosition(binding.value);
  // The slider remains a gesture proxy. Respect its own physical step:
  // harmonic F has step=1, reference sine has MIDI pitch step=.01.
  const coarseSync=()=>{
    const min=Number(slider.min),max=Number(slider.max),rawStep=Number(slider.step);
    const step=Number.isFinite(rawStep)&&rawStep>0?rawStep:0;
    const raw=min+position()*(max-min);
    const quantized=Math.max(min,Math.min(max,
      step?min+Math.round((raw-min)/step)*step:raw));
    slider.value=String(Number(quantized.toFixed(9)));
  };
  let snapEnabled=true;
  let lastRendered="";
  const viewDigits=digits=>(binding.unit==="note"||binding.unit==="cents")?0:digits;
  const display=(force=false)=>{
    // Zero has no pitch notation, but a unit choice must not silently change.
    if(force || field.ownerDocument.activeElement!==field){
      field.value=binding.value<=0&&binding.unit==="note"?"—":
        String(binding.display(viewDigits(getDigits())));
      field.placeholder=binding.unit==="note"?"音名を入力":"";
      lastRendered=field.value;
    }
    if(unitButtons)for(const button of unitButtons.querySelectorAll("button[data-unit]")){
      const isInterval=button.dataset.unit==="semitones"&&
        descriptor.units.includes("cents");
      const on=button.dataset.unit===binding.unit||(isInterval&&binding.unit==="cents");
      button.setAttribute("aria-pressed",String(on));
      if(isInterval){
        const isCents=binding.unit==="cents";
        button.textContent=isCents?"¢":"♩";
        const name=isCents?"セント（再タップで半音）":"半音（再タップでセント）";
        button.title=name;button.setAttribute("aria-label",name);
      }
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
    if(["hz","ratio","coordinate","integer"].includes(binding.unit))
      field.value=String(binding.value);
    else field.value=binding.value<=0&&binding.unit==="note"?"":String(binding.display(viewDigits(8)));
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
    binding.selectUnit(select.value);
    dirty=false;
    display(true); // unit notation must never change DSP value
  });
  // Compact tap targets are the user interface; retain the select as an
  // accessible compatibility value source for legacy tests and adapters.
  const glyph={hz:"Hz",note:"♪",percent:"%",ratio:"×",semitones:"♩",cents:"¢",coordinate:"u",integer:"#"};
  unitButtons=field.ownerDocument.createElement("div");
  unitButtons.className="unit-switch";unitButtons.setAttribute("role","group");
  unitButtons.setAttribute("aria-label",select.getAttribute("aria-label")||"単位");
  // Ratio keeps four exact views but presents only three compact buttons:
  // ×, ♪ (tap again to alternate semitone/cent), and %.
  const intervalPair=descriptor.units.includes("semitones")&&descriptor.units.includes("cents");
  for(const option of select.options){
    if(intervalPair&&option.value==="cents")continue;
    if(!option.value||option.disabled)continue;
    const button=field.ownerDocument.createElement("button");
    button.type="button";button.dataset.unit=option.value;
    button.textContent=glyph[option.value]||option.textContent;
    button.title=intervalPair&&option.value==="semitones"?"半音／セント（再タップで切替）":option.textContent;
    button.setAttribute("aria-label",button.title);
    button.setAttribute("aria-pressed",String(option.value===binding.unit));
    button.addEventListener("click",()=>{
      if(intervalPair&&option.value==="semitones")
        select.value=binding.unit==="semitones"?"cents":"semitones";
      else select.value=option.value;
      select.dispatchEvent(new Event("change",{bubbles:true}));
    });
    unitButtons.append(button);
  }
  select.classList.add("unit-select-source");
  // The buttons are the accessible controls. Keep native select value as the
  // compatible programmatic bridge without an invisible keyboard Tab stop.
  select.tabIndex=-1;
  select.setAttribute("aria-hidden","true");
  select.insertAdjacentElement("afterend",unitButtons);
  if(descriptor.id==="pitch-ratio"){
    // Alt and Ctrl equally bypass the native 0.05 ratio rail step,
    // as well as the independent semitone snap gate. Releasing one while
    // the other is held must not prematurely re-enable coarse stepping.
    const updateFine=event=>{
      const fine=event.altKey||event.ctrlKey;
      slider.step=fine?"any":"0.05";
      if(!fine)coarseSync();
    };
    window.addEventListener("keydown",updateFine,true);
    window.addEventListener("keyup",updateFine,true);
    window.addEventListener("blur",()=>{slider.step="0.05";coarseSync();});
    slider.addEventListener("pointerdown",updateFine);
  }
  const fromSlider=()=>{
    const old=binding.value;
    const normalized=(Number(slider.value)-Number(slider.min))/
      (Number(slider.max)-Number(slider.min));
    binding.setPosition(normalized,{
      origin:"slider",
      // Physical minimum/maximum are explicit endpoints, never replace
      // them with a nearby musical grid snap (e.g. carrier 20 kHz).
      snap:snapEnabled && normalized>0 && normalized<1 && !(held.alt||held.ctrl),
      railPixels:Math.max(1,railRoot.getBoundingClientRect().width)
    });
    coarseSync();
    display();
    if(!Object.is(old,binding.value))onValueChange(binding.value,"slider");
  };
  // Popup is available on the actual slider, its accessible dual thumb,
  // value field and unit selector. Touch hold is cancelled if drag begins.
  const doc=field.ownerDocument;
  const thumb=railRoot.querySelector?.("#"+descriptor.id+"-thumb");
  const targets=[field,select,slider,thumb,...unitButtons.querySelectorAll("button")].filter(Boolean);
  const menu=getSnapMenu(doc);
  const updateHints=()=>{
    for(const node of targets){
      node.dataset.fwSnap=snapEnabled?"on":"off";
      node.setAttribute("data-fw-snap-control","");
      const hint="吸着: "+(snapEnabled?"ON":"OFF")+
        "。長押し／右クリックで切替。AltまたはCtrlを押しながら操作すると一時OFF";
      // Unit icon buttons already carry their meaningful unit/interval
      // tooltip. Do not overwrite it with the snap gesture instructions.
      if(!node.matches("button[data-unit]"))node.title=hint;
      node.setAttribute("aria-description",hint);
    }
  };
  const setSnapEnabled=enabled=>{snapEnabled=Boolean(enabled);updateHints();};
  const showMenu=(x,y)=>{
    // Modal dialog is in the top layer; attach this transient menu there.
    const container=field.closest("dialog[open]")||doc.body;
    if(menu.parentNode!==container)container.append(menu);
    menu._toggle=()=>setSnapEnabled(!snapEnabled);
    menu._button.textContent=snapEnabled?"吸着をオフにする":"吸着をオンにする";
    menu._button.setAttribute("aria-checked",String(snapEnabled));
    placeMenu(menu,x,y);
  };
  for(const node of targets){
    node.addEventListener("contextmenu",event=>{
      event.preventDefault();event.stopPropagation();
      showMenu(event.clientX,event.clientY);
    });
    node.addEventListener("keydown",event=>{
      if(event.key!=="ContextMenu"&&!(event.shiftKey&&event.key==="F10"))return;
      event.preventDefault();
      const r=node.getBoundingClientRect();showMenu(r.left+12,r.bottom+4);
      menu._button.focus();
    });
    let timer=null,point=null;
    const cancel=()=>{if(timer!==null)clearTimeout(timer);timer=null;point=null;};
    node.addEventListener("pointerdown",event=>{
      if(event.pointerType!=="touch"&&event.pointerType!=="pen")return;
      if(event.button!==0)return;
      cancel();point={id:event.pointerId,x:event.clientX,y:event.clientY};
      timer=setTimeout(()=>{
        timer=null;
        if(!point)return;
        const {x,y}=point;point=null;showMenu(x,y);
      },550);
    });
    doc.addEventListener("pointermove",event=>{
      if(point&&point.id===event.pointerId&&
        Math.hypot(event.clientX-point.x,event.clientY-point.y)>10)cancel();
    },true);
    doc.addEventListener("pointerup",event=>{
      if(point?.id===event.pointerId)cancel();
    },true);
    doc.addEventListener("pointercancel",event=>{
      if(point?.id===event.pointerId)cancel();
    },true);
    doc.addEventListener("scroll",cancel,true);
  }
  updateHints();
  coarseSync();
  display(true);
  return Object.freeze({
    get value(){return binding.value;},
    get unit(){return binding.unit;},
    get snapEnabled(){return snapEnabled;},
    setSnapEnabled,
    setDisabled(disabled){
      // #183 replaced the native select with visible buttons. Disabling only
      // that hidden select leaves the actual carrier unit buttons editable.
      const locked=Boolean(disabled);
      for(const node of [field,slider,select])node.disabled=locked;
      for(const button of unitButtons.querySelectorAll("button[data-unit]"))
        button.disabled=locked;
    },
    fromSlider,
    refresh:()=>{coarseSync();display();},
    setCanonical(value){
      binding.setCanonical(value,{origin:"constraint",notify:false});
      coarseSync();
      display();
    },
    reset(){
      binding.reset({notify:false});
      select.value=descriptor.units[0];
      binding.selectUnit(select.value);
      setSnapEnabled(true);
      dirty=false;
      coarseSync();
      display(true);
    }
  });
}

// Backward-compatible name retained for the frequency M1 adapters.
export const mountFrequencyUnitField=mountParameterUnitField;
