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


/** Shared preference UI used by standard and specialized numeric inputs.
 * The parameter owner supplies targets; one menu owns all toggle interactions.
 */
export function attachParameterSnapControls({doc,targets,defaultEnabled=true}){
  if(!doc||!Array.isArray(targets)||!targets.length)
    throw new TypeError("snap controls require a document and targets");
  let snapEnabled=Boolean(defaultEnabled);
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
    const container=targets[0].closest("dialog[open]")||doc.body;
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
  return Object.freeze({
    get enabled(){return snapEnabled;},
    setEnabled:setSnapEnabled,
    gestureEnabled:event=>snapEnabled&&!(held.alt||held.ctrl||event?.altKey||event?.ctrlKey)
  });
}

/** Shared unit-icons component for both canonical parameter fields and specialized
 * consumers (e.g. virtual-root's integer gesture rail). One semantic/visual UI
 * owner; caller owns only its domain-specific rail and value editor. */
export function createParameterUnitSwitch({doc,label,choices,selected,onSelect,unitFor=null}){
  if(!doc||!Array.isArray(choices)||!choices.length||
     typeof selected!=="function"||typeof onSelect!=="function")
    throw new TypeError("unit switch requires choices, selected and onSelect");
  const glyph={hz:"Hz",note:"♪",percent:"%",ratio:"×",semitones:"♩",cents:"¢",coordinate:"u",integer:"#"};
  const root=doc.createElement("div");root.className="unit-switch";
  root.setAttribute("role","group");root.setAttribute("aria-label",label||"単位");
  const intervalPair=choices.some(item=>item.value==="semitones")&&
    choices.some(item=>item.value==="cents");
  const buttons=[];
  for(const option of choices){
    if(!option.value||option.disabled||(intervalPair&&option.value==="cents"))continue;
    const button=doc.createElement("button");button.type="button";
    button.dataset.unit=option.value;
    if(unitFor!==null){button.dataset.vrUnitFor=unitFor;button.dataset.vrUnit=option.value;}
    button.textContent=glyph[option.value]||option.label||option.value;
    button.title=intervalPair&&option.value==="semitones"?
      "半音／セント（再タップで切替）":(option.label||option.value);
    button.setAttribute("aria-label",button.title);
    button.addEventListener("click",()=>{
      const next=intervalPair&&option.value==="semitones"?
        (selected()==="semitones"?"cents":"semitones"):option.value;
      onSelect(next);refresh();
    });
    root.append(button);buttons.push(button);
  }
  const refresh=()=>{
    const current=selected();
    for(const button of buttons){
      const isInterval=intervalPair&&button.dataset.unit==="semitones";
      const active=button.dataset.unit===current||(isInterval&&current==="cents");
      button.setAttribute("aria-pressed",String(active));
      if(isInterval){
        const isCents=current==="cents";
        button.textContent=isCents?"¢":"♩";
        const title=isCents?"セント（再タップで半音）":"半音（再タップでセント）";
        button.title=title;button.setAttribute("aria-label",title);
      }
    }
  };
  refresh();
  return Object.freeze({element:root,refresh});
}


/** #79 M3 common typed %-field lifecycle for canonical fraction bindings.
 * Preserve each parameter's own effect on audio/graph after a successful change.
 * Range sliders remain gesture proxies and are managed by their owning app.
 */
export function mountPercentParameterField({field,binding,refresh,onChanged=()=>{}}){
  if(!field||!binding||typeof binding.setView!=="function"||
     typeof binding.display!=="function"||typeof refresh!=="function"||
     typeof onChanged!=="function")
    throw new TypeError("percent field requires field, canonical binding, refresh and change callback");
  const commit=()=>{
    const previous=binding.value;
    try{
      binding.setView(field.value,{unit:"percent",origin:"typed",
        overflow:"clamp",notify:false});
      delete field.dataset.invalid;
    }catch{
      field.dataset.invalid="true";
      return false;
    }
    refresh();
    if(!Object.is(previous,binding.value))onChanged(binding.value,previous);
    return true;
  };
  const listeners=[
    ["focus",()=>{field.value=String(binding.display(3));field.select();}],
    ["input",commit],["change",commit],
    ["blur",()=>{commit();refresh(true);delete field.dataset.invalid;}],
    ["keydown",event=>{if(event.key==="Enter")field.blur();}]
  ];
  for(const [type,listener] of listeners)field.addEventListener(type,listener);
  return Object.freeze({
    commit,
    dispose:()=>{for(const [type,listener] of listeners)field.removeEventListener(type,listener);}
  });
}

export function mountParameterUnitField({descriptor,field,select,slider,railRoot,
  initialValue=descriptor.defaultValue,getDigits=()=>descriptor.digits,
  onValueChange=()=>{},snapEnabledDefault=true}) {
  if (![field,select,slider,railRoot].every(Boolean) ||
      typeof onValueChange !== "function")
    throw new TypeError("frequency unit field controls are required");
  const binding=createParameterBinding(descriptor,{initialValue});
  let unitButtons=null,unitSwitch=null;
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
  let lastRendered="";
  const viewDigits=digits=>(binding.unit==="note"||binding.unit==="cents")?0:digits;
  const display=(force=false)=>{
    // Exact Float64 stays in the binding, never in an uncontrolled text length.
    // Read-only canonical metadata allows regression tests to distinguish
    // internal precision from the user-facing maximum 3 decimal digits.
    field.dataset.fwCanonical=String(binding.value);
    // Zero has no pitch notation, but a unit choice must not silently change.
    if(force || field.ownerDocument.activeElement!==field){
      field.value=binding.value<=0&&binding.unit==="note"?"—":
        String(binding.display(viewDigits(getDigits())));
      field.placeholder=binding.unit==="note"?"音名を入力":"";
      lastRendered=field.value;
    }
    unitSwitch?.refresh();
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
    field.dataset.fwCanonical=String(binding.value);
    if(["hz","ratio","coordinate","integer"].includes(binding.unit))
      field.value=String(Number(binding.value.toFixed(Math.min(3,getDigits()))));
    else field.value=binding.value<=0&&binding.unit==="note"?"":String(binding.display(viewDigits(Math.min(3,getDigits()))));
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
  // Shared view component; retain the hidden native select as the legacy
  // compatibility bridge without duplicating icon markup/ARIA in consumers.
  unitSwitch=createParameterUnitSwitch({
    doc:field.ownerDocument,label:select.getAttribute("aria-label")||"単位",
    choices:[...select.options].map(option=>({value:option.value,label:option.textContent,disabled:option.disabled})),
    selected:()=>binding.unit,
    onSelect:unit=>{select.value=unit;select.dispatchEvent(new Event("change",{bubbles:true}));}
  });
  unitButtons=unitSwitch.element;
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
      snap:snapControl.gestureEnabled() && normalized>0 && normalized<1,
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
  const snapControl=attachParameterSnapControls({doc,targets,defaultEnabled:snapEnabledDefault});
  coarseSync();
  display(true);
  return Object.freeze({
    get value(){return binding.value;},
    get unit(){return binding.unit;},
    get snapEnabled(){return snapControl.enabled;},
    setSnapEnabled:enabled=>snapControl.setEnabled(enabled),
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
      snapControl.setEnabled(snapEnabledDefault);
      dirty=false;
      coarseSync();
      display(true);
    }
  });
}

// Backward-compatible name retained for the frequency M1 adapters.
export const mountFrequencyUnitField=mountParameterUnitField;

/** #79 M2/M3: integer-count control bound to one canonical numeric owner.
 * Existing native number + integer slider remain the UI (no fake Hz or %
 * view); partially typed values cannot contaminate harmonic/audio state.
 */
export function mountIntegerParameterField({descriptor,field,slider,onValueChange=()=>{}}){
  if(!field||!slider||typeof onValueChange!=="function"||
     descriptor?.units?.length!==1||descriptor.units[0]!=="integer"||
     !Number.isInteger(descriptor.min)||!Number.isInteger(descriptor.max)||
     !Number.isInteger(descriptor.defaultValue))
    throw new TypeError("integer parameter requires compatible descriptor and controls");
  const binding=createParameterBinding(descriptor);
  const reflect=(showField=true)=>{
    slider.value=String(binding.value);
    if(showField)field.value=String(binding.value);
  };
  const commit=(raw,origin)=>{
    if(raw===""||raw===null||!Number.isFinite(Number(raw)))return false;
    const previous=binding.value;
    binding.setCanonical(Math.round(Number(raw)),{origin,notify:false});
    reflect(origin!=="typed");
    if(!Object.is(previous,binding.value))onValueChange(binding.value,previous,origin);
    return true;
  };
  const onTyped=()=>{field.dataset.invalid=commit(field.value,"typed")?"false":"true";};
  const onChange=()=>{
    if(!commit(field.value,"typed"))reflect();
    else reflect();
    delete field.dataset.invalid;
  };
  const onBlur=()=>{reflect();delete field.dataset.invalid;};
  const onFocus=()=>field.select?.();
  const onSlider=()=>{commit(slider.value,"slider");};
  const onKey=event=>{if(event.key==="Enter")field.blur?.();};
  const listeners=[
    [field,"focus",onFocus],[field,"input",onTyped],
    [field,"change",onChange],[field,"blur",onBlur],
    [field,"keydown",onKey],[slider,"input",onSlider]
  ];
  for(const [node,event,fn] of listeners)node.addEventListener(event,fn);
  reflect();
  return Object.freeze({
    get value(){return binding.value;},
    setCanonical(value){
      if(!Number.isInteger(value))throw new RangeError("count must be an integer");
      binding.setCanonical(value,{origin:"restore",overflow:"reject",notify:false});
      reflect();
    },
    reset(){
      binding.reset({notify:false});reflect();
    },
    refresh:()=>reflect(),
    dispose:()=>{for(const [node,event,fn] of listeners)node.removeEventListener(event,fn);}
  });
}
