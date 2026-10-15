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
  const position=()=>descriptor.rail.toPosition(binding.value);
  // The slider remains a gesture proxy. Respect its own physical step:
  // harmonic F has step=1, reference sine has MIDI pitch step=.01.
  const coarseSync=()=>{
    const min=Number(slider.min),max=Number(slider.max),rawStep=Number(slider.step);
    const step=Number.isFinite(rawStep)&&rawStep>0?rawStep:1;
    const raw=min+position()*(max-min);
    const quantized=Math.max(min,Math.min(max,
      min+Math.round((raw-min)/step)*step));
    slider.value=String(Number(quantized.toFixed(9)));
  };
  let snapEnabled=true;
  let lastRendered="";
  const viewDigits=digits=>(binding.unit==="note"||binding.unit==="cents")?0:digits;
  const display=(force=false)=>{
    // A 0-Hz pivot has no musical-note spelling. Recover into a valid
    // physical view instead of throwing and breaking live controls.
    if(binding.value<=0&&binding.unit==="note"){
      binding.selectUnit("hz");select.value="hz";
    }
    if(force || field.ownerDocument.activeElement!==field){
      field.value=String(binding.display(viewDigits(getDigits())));
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
    if(["hz","ratio","coordinate","integer"].includes(binding.unit))
      field.value=String(binding.value);
    else field.value=String(binding.display(viewDigits(8)));
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
  const targets=[field,select,slider,thumb].filter(Boolean);
  const menu=getSnapMenu(doc);
  const updateHints=()=>{
    for(const node of targets){
      node.dataset.fwSnap=snapEnabled?"on":"off";
      node.setAttribute("data-fw-snap-control","");
      const hint="吸着: "+(snapEnabled?"ON":"OFF")+
        "。長押し／右クリックで切替。AltまたはCtrlを押しながら操作すると一時OFF";
      node.title=hint;node.setAttribute("aria-description",hint);
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
      setSnapEnabled(true);
      dirty=false;
      coarseSync();
      display(true);
    }
  });
}

// Backward-compatible name retained for the frequency M1 adapters.
export const mountFrequencyUnitField=mountParameterUnitField;
