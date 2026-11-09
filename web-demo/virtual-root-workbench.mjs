/** User-directed #276 V5 interface. Legacy harmonics-panel and old DSP stay intact.
 * Compact arithmetic progression, signed auto-fold, direct realtime DSP updates.
 */
import {createVirtualRootPlan} from "./virtual-root-plan.mjs";
import {hzFromVirtualRootRail,virtualRootRailFromHz} from "./virtual-root-rail.mjs";
import {parseView,hzToMidi,midiToHz} from "./parameter-units.mjs";
import {defineParameter,createParameterBinding} from "./parameter-binding.mjs";
import {createDigitWheelPicker} from "./digit-wheel-picker.mjs";
import {createParameterUnitSwitch,attachParameterSnapControls} from "./frequency-unit-field.mjs";
const $=selector=>document.querySelector(selector);
const finite=v=>typeof v==="number"&&Number.isFinite(v);
const fmt=(v,digits=3)=>finite(v)?Number(v.toFixed(digits)).toString():"—";
const clamp=(n,a,b)=>Math.max(a,Math.min(b,n));
function fraction({n,m}){
  const node=document.createElement("span");node.className="vr-fraction";
  node.setAttribute("role","math");node.setAttribute("aria-label",n+" / "+m);
  for(const [type,num] of [["vr-numerator",n],["vr-denominator",m]]){
    const item=document.createElement("span");item.className=type;item.textContent=String(num);node.append(item);
  }
  return node;
}
const field=(key,title,value,min,max,step,rail=true)=>`
  <div class="vr-control" data-vr-control="${key}">
    <label for="vr-${key}">${title}</label>
    ${key==="target-h"||key==="source-f"?`<div data-vr-unit-slot="${key}"></div>`:""}
    <div class="vr-number-row">
      <input id="vr-${key}" type="number" inputmode="decimal" step="${step}" min="${min}" max="${max}" value="${value}" aria-label="${title}">
      <button type="button" class="vr-digit-open" data-vr-digit="${key}" aria-expanded="false" aria-controls="vr-wheel-overlay">桁ロール</button>
    </div>
    ${rail?`<div class="vr-linear-rail"><input id="vr-${key}-rail" type="range" min="${key==="target-h"||key==="source-f"?1:min}" max="${key==="target-h"?200:key==="source-f"?1000:max}" step="1" value="${Math.round(value)}" aria-label="${title}を整数単位で調整">${key==="target-h"||key==="source-f"?`<select id="vr-${key}-scale" aria-label="${title}のバー操作範囲"><option value="200"${key==="target-h"?" selected":""}>〜200</option><option value="1000"${key==="source-f"?" selected":""}>〜1k</option><option value="5000">〜5k</option><option value="20000">〜20k</option></select>`:""}</div>`:""}
  </div>`;
export function mountVirtualRootWorkbench({onApply,onCurrent}){
  const root=$("#virtual-root-workbench");if(!root)return;
  const harmonicPlacement=root.querySelector("#harmonic-placement-details");
  root.innerHTML=`
    <summary class="section-header vr-header"><h2>倍音を配置する</h2></summary>
    <div class="vr-inputs">
      ${field("source-f","元基音 F",350,.001,5120000,"any")}
      <div class="vr-control"><label for="vr-placement">音程の配置</label><select id="vr-placement">
        <option value="target">仮想基音を動かす</option><option value="keep-spacing" selected>元の倍音間隔を維持</option>
      </select></div>
      ${field("target-h","仮想基音 H",87.5,.001,20000,"any")}
      ${field("step-m","番号間隔",4,1,64,1)}
      ${field("first-index","初項",1,-129,129,1)}
    </div>
    <p id="vr-sequence" class="vr-sequence" aria-live="polite"></p>
    <div id="vr-formula" class="vr-formula"></div>
    <p id="vr-sync-note" class="vr-sync-note" role="status" aria-live="polite" hidden></p>
    <details id="vr-details"><summary>詳細表示</summary>
      <p id="vr-summary" class="vr-summary"></p>
      <p class="vr-legend"><span>━ 元の部分音</span><span>━ 配置後の部分音（理論）</span></p>
      <div id="vr-preview" class="vr-preview" role="list" aria-label="倍音配置の詳細"></div>
    </details>
    <p id="vr-error" class="vr-error" role="status" hidden></p>`;
  const inputArea=root.querySelector(".vr-inputs");
  if(harmonicPlacement&&inputArea)root.insertBefore(harmonicPlacement,inputArea);
  // Shared canonical bindings own F/H; the special virtual-root rails and digit
  // controls only adapt gestures. No parallel frequency/unit store in this UI.
  // A selected rail span is gesture-only state, never auto-grown by a typed
  // canonical value outside that span. Only the user's scale selector changes it.
  const scopes={F:1000,H:200};
  const railToPosition=(key,v)=>getUnit(key)==="note"?
    clamp((hzToMidi(v)-hzToMidi(1))/(hzToMidi(scopes[key])-hzToMidi(1)),0,1):
    clamp((v-1)/(scopes[key]-1),0,1);
  const railFromPosition=(key,t)=>getUnit(key)==="note"?
    midiToHz(hzToMidi(1)+(hzToMidi(scopes[key])-hzToMidi(1))*t):
    1+(scopes[key]-1)*t;
  const createFrequencyBinding=(key,initialValue)=>createParameterBinding(defineParameter({
    id:key==="F"?"virtual-root-f":"virtual-root-h",
    min:Number.MIN_VALUE,max:Number.MAX_VALUE,defaultValue:initialValue,
    units:["hz","note","percent"],digits:2,
    snap:{unit:"note",mode:"step",step:1,thresholdPx:6,during:["slider"]},
    // The integer-Hz rail remains the intentionally coarse Hz gesture;
    // note and % use their shared per-unit magnetic snap policies.
    snapByUnit:{hz:false},
    rail:{
      fromPosition:t=>railFromPosition(key,t),
      toPosition:v=>railToPosition(key,v)
    }
  }));
  const frequencyBindings={F:createFrequencyBinding("F",350),H:createFrequencyBinding("H",87.5)};
  const state={
    get F(){return frequencyBindings.F.value;},
    set F(value){frequencyBindings.F.setCanonical(value,{notify:false,overflow:"reject"});},
    get H(){return frequencyBindings.H.value;},
    set H(value){frequencyBindings.H.setCanonical(value,{notify:false,overflow:"reject"});},
    m:4,h1:1
  };
  const inputIds={F:"vr-source-f",H:"vr-target-h",m:"vr-step-m",h1:"vr-first-index"};
  const keyIds={F:"source-f",H:"target-h",m:"step-m",h1:"first-index"};
  const controls=Object.fromEntries(Object.entries(keyIds).map(([key,id])=>[key,$("#vr-"+id)]));
  const rails=Object.fromEntries(Object.entries(keyIds).map(([key,id])=>[key,$("#vr-"+id+"-rail")]));
  const percentOpts=key=>({id:frequencyBindings[key].descriptor.id,digits:2,
    fromRail:frequencyBindings[key].descriptor.rail.fromPosition});
  const getUnit=key=>frequencyBindings[key]?.unit||"hz";
  let wheel=null;
  // Both the standard numeric inputs and this specialized lab consume the
  // same icon/label/ARIA unit-switch component. Only the rail and digit
  // gestures remain lab-specific.
  const unitSwitches={},snapControllers={};
  for(const [key,id,title] of [["F","source-f","元基音 F"],["H","target-h","仮想基音 H"]]){
    const slot=root.querySelector('[data-vr-unit-slot="'+id+'"]');
    const view=createParameterUnitSwitch({
      doc:slot.ownerDocument,label:title+"の単位",unitFor:id,
      choices:[{value:"hz",label:"Hz"},{value:"note",label:"音名＋セント"},{value:"percent",label:"%"}],
      selected:()=>getUnit(key),
      onSelect:unit=>{
        if(wheel?.isOpen())wheel.close(false);
        frequencyBindings[key].selectUnit(unit);
        const el=controls[key],selectedUnit=getUnit(key);
        el.type=selectedUnit==="note"?"text":"number";
        el.inputMode=selectedUnit==="note"?"text":"decimal";
        el.step="any";
        root.querySelector('[data-vr-digit="'+id+'"]').hidden=selectedUnit==="note";
        el.min=selectedUnit==="percent"?"0":".001";
        el.max=selectedUnit==="percent"?"100":String(key==="H"?20000:5120000);
        render();
      }
    });
    view.element.classList.add("vr-unit-switch");
    slot.replaceWith(view.element);unitSwitches[key]=view;
    // One shared snap menu/interaction contract for all canonical bindings,
    // including specialized harmonic rails; never reimplement its handlers.
    snapControllers[key]=attachParameterSnapControls({
      doc:root.ownerDocument,defaultEnabled:true,
      targets:[controls[key],rails[key],...view.element.querySelectorAll("button[data-unit]")]
    });
  }
  function fromText(key,raw){
    if(!String(raw).trim())return null;
    const unit=getUnit(key);
    if(unit!=="note"&&!/^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(String(raw)))return null;
    try{
      const n=(key==="H"||key==="F")?
        parseView(raw,unit,percentOpts(key)):Number(raw);
      if(!finite(n))return null;
      if((key==="H"||key==="F")&&n<=0)return null;
      if(key==="H"&&n>20000 || key==="F"&&n>5120000)return null;
      if(key==="m"&&(!Number.isSafeInteger(n)||n<1||n>64))return null;
      if(key==="h1"&&(!Number.isSafeInteger(n)||n< -129||n>129))return null;
      return n;
    }catch{return null;}
  }
  const displayValue=(key,digits=1)=>key==="H"||key==="F"?
    String(frequencyBindings[key].display(digits)):String(state[key]);
  let activePlan=null,lastFingerprint="",generation=0;
  const error=$("#vr-error");
  function render(){
    const keep=$("#vr-placement").value==="keep-spacing";
    if(keep)state.H=state.F/state.m;
    const actual=onCurrent?.(),note=$("#vr-sync-note");
    const mismatch=keep&&Number.isFinite(actual?.r)&&Math.abs(actual.r-1)>1e-10;
    note.hidden=!mismatch;
    note.textContent=mismatch?"未適用の配置案：表示H="+fmt(state.H,3)+" Hz（倍率1倍）。現在の倍音設定は倍率"+fmt(actual.r,3)+"倍、H="+fmt(actual.F*actual.r/actual.m,3)+" Hz。次の配置操作で維持配置を適用します。":"";
    controls.H.readOnly=keep;rails.H.disabled=keep;
    root.querySelector('[data-vr-digit="target-h"]').disabled=keep;
    for(const key of Object.keys(controls)){
      if(key==="H"||key==="F"){
        const scopeSelect=$("#vr-"+keyIds[key]+"-scale");
        scopeSelect.value=String(scopes[key]);
        const noteRail=getUnit(key)==="note";
        rails[key].min=String(noteRail?hzToMidi(1):1);
        rails[key].max=String(noteRail?hzToMidi(scopes[key]):scopes[key]);
        rails[key].step=noteRail?".01":"1";
        rails[key].setAttribute("aria-valuetext",fmt(state[key],1)+"Hz");
      }
      const el=controls[key];
      if(key==="H"||key==="F")el.dataset.fwCanonical=String(state[key]);
      if(document.activeElement!==el)el.value=displayValue(key);
      el.setAttribute("aria-invalid","false");
      if(rails[key])rails[key].value=String(key==="H"||key==="F"?
        (getUnit(key)==="note"?hzToMidi(Math.max(1,Math.min(scopes[key],state[key]))):
        Math.min(scopes[key],virtualRootRailFromHz(state[key]).position)):state[key]);
      if(key==="H"||key==="F")unitSwitches[key].refresh();
    }
    try{
      activePlan=createVirtualRootPlan({
        F:state.F,H:state.H,m:state.m,h1:state.h1,mode:"auto-fold",
        placement:keep?"keep-spacing":"target",count:8
      });
      const p=activePlan;
      const seq=p.outputs.map(row=>fmt(row.gridIndex,1)).join(", ");
      $("#vr-sequence").textContent="倍音列: "+seq+"…";
      $("#vr-formula").replaceChildren(document.createTextNode("aₖ = |"+state.h1+" + (k−1) × "+state.m+"| × "+fmt(p.H,2)+" Hz　 Δ = "),fraction(p.fraction),
        document.createTextNode(" × "+fmt(p.pitched,2)+" Hz"));
      $("#vr-summary").textContent="F′ "+fmt(p.pitched,2)+" Hz · Pitch "+fmt(p.ratio,3)+"倍 · 仮想基音 H "+fmt(p.H,2)+" Hz · 周波数 "+p.outputs.slice(0,5).map(row=>fmt(row.output,3)).join(", ")+"…";
      const graph=$("#vr-preview"),part=document.createDocumentFragment();
      const max=Math.max(1,...p.outputs.flatMap(row=>[row.source,row.output]));
      for(const row of p.outputs){
        const el=document.createElement("div");el.className="vr-partial";el.setAttribute("role","listitem");
        if(row.reflected)el.classList.add("vr-is-reflected");
        if(row.atRoot)el.classList.add("at-virtual-root");
        const caption=document.createElement("div");caption.className="vr-partial-caption";
        caption.textContent="第"+row.k+"倍音 "+fmt(row.source)+" Hz → "+
          (row.reflected?fmt(row.signed)+" Hz → 0Hz折返し → ":"")+
          fmt(row.output)+" Hz";
        el.append(caption);
        for(const [value,cls] of [[row.source,"vr-original-bar"],[row.output,""]]){
          const track=document.createElement("div");track.className="vr-partial-track";
          const bar=document.createElement("span");bar.className="vr-partial-bar "+cls;
          bar.style.width=Math.max(1,100*value/max)+"%";track.append(bar);el.append(track);
        }
        part.append(el);
      }
      graph.replaceChildren(part);
      error.hidden=true;error.textContent="";
    }catch(e){activePlan=null;error.hidden=false;error.textContent="数値を確認してください";$("#vr-sequence").textContent="";$("#vr-preview").replaceChildren();}
  }
  // Gesture span is not the canonical signed integer validity range.
  // Keep both current and legacy fraction rails aligned with one preference.
  const fractionSpanSelect=$("#fraction-slider-span");
  const syncFractionGestureSpan=()=>{
    const half=Number(fractionSpanSelect?.value)||16;
    for(const rail of [rails.h1,$("#numerator-range")]){
      if(!rail)continue;
      rail.min=String(-half);rail.max=String(half);
    }
    render();
  };
  fractionSpanSelect?.addEventListener("change",syncFractionGestureSpan);
  syncFractionGestureSpan();
  const applyRealtime=()=>{
    const version=++generation;
    const p=activePlan;
    if(!p?.capability.rationalStage)return;
    const fp=[p.F,p.H,p.m,p.h1,p.numerator,p.ratio,p.shift,p.placement].join("|");
    if(fp===lastFingerprint)return;
    // Batch rapid slider gestures to one real engine parameter transaction per frame.
    requestAnimationFrame(()=>{
      if(version!==generation||!activePlan||!activePlan.capability.rationalStage)return;
      try{onApply(activePlan);lastFingerprint=fp;error.hidden=true;error.textContent="";render();}
      catch(e){error.hidden=false;error.textContent="音声設定エラー";error.title=String(e.message||e);}
    });
  };
  function changed(key){
    const n=fromText(key,controls[key].value);
    if(n===null){controls[key].setAttribute("aria-invalid","true");return;}
    state[key]=n;
    render();applyRealtime();
  }
  for(const key of Object.keys(controls)){
    const el=controls[key];
    el.addEventListener("focus",()=>{
      if((key==="F"||key==="H")&&getUnit(key)!=="note"){
        el.value=getUnit(key)==="hz"?String(state[key]):String(frequencyBindings[key].display(12));el.select();
      }
    });
    el.addEventListener("input",()=>changed(key));
    el.addEventListener("change",()=>{changed(key);if(document.activeElement!==el)el.value=displayValue(key);});
    el.addEventListener("blur",()=>{el.value=displayValue(key);el.setAttribute("aria-invalid","false");});
    if(rails[key])rails[key].addEventListener("input",event=>{
      const raw=Number(rails[key].value);
      if(key==="m"||key==="h1")state[key]=Math.round(raw);
      else {
        // Reuse the shared canonical binding's rail-aware pitch grid.
        // Gesture-only snap; direct cents input and unit switch never quantize Hz.
        const binding=frequencyBindings[key];
        const snap=snapControllers[key].gestureEnabled(event);
        // A display-unit switch never edits the numeric value; only gestures
        // choose a unit-specific grid (♪ semitones, % integer rail position).
        binding.setCanonical(getUnit(key)==="note"?midiToHz(raw):hzFromVirtualRootRail(raw),{
          origin:"slider",snap,
          railPixels:Math.max(1,rails[key].getBoundingClientRect().width),
          overflow:"reject",notify:false
        });
      }
      render();applyRealtime();
    });
  }
  $("#vr-placement").addEventListener("change",()=>{render();applyRealtime();});
  for(const key of ["H","F"]){
    $("#vr-"+keyIds[key]+"-scale").addEventListener("change",event=>{
      const requested=Number(event.target.value);
      scopes[key]=requested;
      // Scale changes adjust only the gesture/percentage view, not stored Hz.
      // If the typed frequency lies above the gesture range, preserve it.
      const slider=rails[key];
      const noteRail=getUnit(key)==="note";
      slider.max=String(noteRail?hzToMidi(requested):requested);
      slider.value=String(noteRail?hzToMidi(Math.max(1,Math.min(requested,state[key]))):
        Math.min(requested,virtualRootRailFromHz(state[key]).position));
      // Manual range selection is a view change and must not trigger audio.
      if(getUnit(key)==="percent"&&document.activeElement!==controls[key])
        controls[key].value=displayValue(key);
    });
  }
  // A single coordinated touch wheel replaces independent per-digit selects.
  // The numeric input itself retains the browser's intrinsic desktop spinbutton.
  wheel=createDigitWheelPicker({onValue:(key,value)=>{
    if(controls[key].readOnly)return false;
    const parsed=fromText(key,String(value)); // same canonical unit/validation codec
    if(parsed===null)return false;
    state[key]=parsed;render();applyRealtime();return true;
  }});
  const hzPlaces={
    F:[6,5,4,3,2,1,0,-1,-2],H:[4,3,2,1,0,-1,-2],
    m:[1,0],h1:[2,1,0]
  };
  for(const button of root.querySelectorAll("[data-vr-digit]")){
    button.addEventListener("click",()=>{
      const key=Object.keys(keyIds).find(name=>keyIds[name]===button.dataset.vrDigit);
      if(!key||controls[key].readOnly||getUnit(key)==="note")return;
      const percent=getUnit(key)==="percent";
      wheel.open({key,label:controls[key].getAttribute("aria-label"),
        value:Number(key==="H"||key==="F"?displayValue(key,3):displayValue(key)),
        places:percent?[2,1,0,-1,-2]:hzPlaces[key],
        signed:key==="h1",trigger:button});
    });
  }
  document.addEventListener("fw:virtual-root-external-change",()=>{
    if(wheel?.isOpen())wheel.close(false);
    generation++;lastFingerprint="";
    const old=onCurrent?.();
    if(old&&finite(old.F)&&old.F>0&&finite(old.r)&&old.r>0&&Number.isSafeInteger(old.m)&&old.m>=1&&old.m<=64){
      const first=old.m+old.n;
      if(Number.isSafeInteger(first)&&first>=-129&&first<=129){
        Object.assign(state,{F:old.F,H:old.F*old.r/old.m,m:old.m,h1:first});
        // Do not override the user-selected placement during external state restore.
      }
    }
    render(); // Loading A/B/Reset is already an existing DSP transaction; never write again.
  });
  render(); // Initial mount never overwrites existing audio settings.
  return Object.freeze({
    captureView:()=>({
      placement:$("#vr-placement").value,
      scopes:{F:scopes.F,H:scopes.H},
      units:{F:getUnit("F"),H:getUnit("H")},
      snaps:{F:snapControllers.F.enabled,H:snapControllers.H.enabled}
    }),
    restoreView:view=>{
      if(!view||!["target","keep-spacing"].includes(view.placement))
        throw Error("Invalid workbench placement");
      for(const key of ["F","H"]){
        const allowed=[...$("#vr-"+keyIds[key]+"-scale").options].map(option=>Number(option.value));
        if(!allowed.includes(view.scopes?.[key])||
          !["hz","note","percent"].includes(view.units?.[key])||
          typeof view.snaps?.[key]!=="boolean")
          throw Error("Invalid workbench view "+key);
      }
      $("#vr-placement").value=view.placement;
      for(const key of ["F","H"]){
        scopes[key]=view.scopes[key];
        const button=unitSwitches[key].element.querySelector('button[data-unit="'+view.units[key]+'"]');
        if(getUnit(key)!==view.units[key])button.click();
        snapControllers[key].setEnabled(view.snaps[key]);
      }
      render(); // View restore never writes DSP values.
    }
  });
}
