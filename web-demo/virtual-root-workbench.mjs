/** User-directed #276 V5 interface. Legacy harmonics-panel and old DSP stay intact.
 * Compact arithmetic progression, signed auto-fold, direct realtime DSP updates.
 */
import {createVirtualRootPlan} from "./virtual-root-plan.mjs";
import {hzFromVirtualRootRail,virtualRootRailFromHz} from "./virtual-root-rail.mjs";
import {parseView} from "./parameter-units.mjs";
import {defineParameter,createParameterBinding} from "./parameter-binding.mjs";
import {createParameterUnitSwitch} from "./frequency-unit-field.mjs";
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
      <button type="button" class="vr-counter" data-vr-counter="${key}" data-delta="-1" aria-label="${title}を減らす">−</button>
      <input id="vr-${key}" type="number" inputmode="decimal" step="${step}" min="${min}" max="${max}" value="${value}" aria-label="${title}">
      <button type="button" class="vr-counter" data-vr-counter="${key}" data-delta="1" aria-label="${title}を増やす">+</button>
      <button type="button" class="vr-digit-open" data-vr-digit="${key}" aria-expanded="false" aria-controls="vr-digits-${key}">桁別</button>
    </div>
    <div id="vr-digits-${key}" class="vr-digit-picker" hidden></div>
    ${rail?`<div class="vr-linear-rail"><input id="vr-${key}-rail" type="range" min="${key==="target-h"||key==="source-f"?1:min}" max="${key==="target-h"?200:key==="source-f"?1000:max}" step="1" value="${Math.round(value)}" aria-label="${title}を整数単位で調整">${key==="target-h"||key==="source-f"?`<select id="vr-${key}-scale" aria-label="${title}のバー操作範囲"><option value="200"${key==="target-h"?" selected":""}>〜200</option><option value="1000"${key==="source-f"?" selected":""}>〜1k</option><option value="5000">〜5k</option><option value="20000">〜20k</option></select>`:""}</div>`:""}
  </div>`;
function makeDigitPicker(key,places,signed,input,change){
  const root=$("#vr-digits-"+key),button=document.querySelector('[data-vr-digit="'+key+'"]');
  let controls=[];
  if(signed){
    const sign=document.createElement("select");sign.setAttribute("aria-label","符号");
    for(const [v,name] of [["1","+"],["-1","−"]]){
      const option=document.createElement("option");option.value=v;option.textContent=name;sign.append(option);
    }
    root.append(sign);controls.push({select:sign,place:null});
  }
  for(const place of places){
    const select=document.createElement("select");
    select.setAttribute("aria-label",place<0?"小数第"+(-place)+"位":"10の"+place+"乗の桁");
    for(let i=0;i<=9;i++){
      const option=document.createElement("option");option.value=String(i);option.textContent=String(i);
      select.append(option);
    }
    root.append(select);controls.push({select,place});
  }
  const sync=()=>{
    const v=Number(input.value)||0;
    for(const {select,place} of controls)
      select.value=place===null?(v<0?"-1":"1"):
        String(Math.floor(Math.abs(v)/10**place+1e-8)%10);
  };
  root.addEventListener("change",()=>{
    let amount=0,sign=1;
    for(const {select,place} of controls){
      if(place===null)sign=Number(select.value);
      else amount+=Number(select.value)*10**place;
    }
    input.value=String(Number((sign*amount).toFixed(2)));
    change();
  });
  button.addEventListener("click",()=>{
    root.hidden=!root.hidden;button.setAttribute("aria-expanded",String(!root.hidden));
    if(!root.hidden)sync();
  });
  return sync;
}
export function mountVirtualRootWorkbench({onApply,onCurrent}){
  const root=$("#virtual-root-workbench");if(!root)return;
  root.innerHTML=`
    <div class="section-header"><h2>倍音を配置する</h2></div>
    <div class="vr-inputs">
      ${field("source-f","元基音 F",350,.01,5120000,.01)}
      <div class="vr-control"><label for="vr-placement">音程の配置</label><select id="vr-placement">
        <option value="target">仮想基音を動かす</option><option value="keep-spacing">元の倍音間隔を維持</option>
      </select></div>
      ${field("target-h","仮想基音 H",87.5,.01,20000,.01)}
      ${field("step-m","番号間隔",4,1,64,1)}
      ${field("first-index","初項",1,-129,129,1)}
    </div>
    <p id="vr-sequence" class="vr-sequence" aria-live="polite"></p>
    <div id="vr-formula" class="vr-formula"></div>
    <details id="vr-details"><summary>詳細表示</summary>
      <p id="vr-summary" class="vr-summary"></p>
      <p class="vr-legend"><span>━ 元の部分音</span><span>━ 配置後の部分音（理論）</span></p>
      <div id="vr-preview" class="vr-preview" role="list" aria-label="倍音配置の詳細"></div>
    </details>
    <p id="vr-error" class="vr-error" role="status" hidden></p>`;
  // Shared canonical bindings own F/H; the special virtual-root rails and digit
  // controls only adapt gestures. No parallel frequency/unit store in this UI.
  const scopes={F:1000,H:200}, choices=[200,1000,5000,20000];
  const createFrequencyBinding=(key,initialValue)=>createParameterBinding(defineParameter({
    id:key==="F"?"virtual-root-f":"virtual-root-h",
    min:Number.MIN_VALUE,max:Number.MAX_VALUE,defaultValue:initialValue,
    units:["hz","note","percent"],digits:2,
    rail:{
      fromPosition:t=>1+(scopes[key]-1)*t,
      toPosition:v=>clamp((v-1)/(scopes[key]-1),0,1)
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
  // Both the standard numeric inputs and this specialized lab consume the
  // same icon/label/ARIA unit-switch component. Only the rail and digit
  // gestures remain lab-specific.
  const unitSwitches={};
  for(const [key,id,title] of [["F","source-f","元基音 F"],["H","target-h","仮想基音 H"]]){
    const slot=root.querySelector('[data-vr-unit-slot="'+id+'"]');
    const view=createParameterUnitSwitch({
      doc:slot.ownerDocument,label:title+"の単位",unitFor:id,
      choices:[{value:"hz",label:"Hz"},{value:"note",label:"音名＋セント"},{value:"percent",label:"%"}],
      selected:()=>getUnit(key),
      onSelect:unit=>{
        frequencyBindings[key].selectUnit(unit);
        const el=controls[key],selectedUnit=getUnit(key);
        el.type=selectedUnit==="note"?"text":"number";
        el.inputMode=selectedUnit==="note"?"text":"decimal";
        el.step=selectedUnit==="note"?"any":".01";
        root.querySelector('[data-vr-digit="'+id+'"]').hidden=selectedUnit==="note";
        if(selectedUnit==="note")root.querySelector("#vr-digits-"+id).hidden=true;
        el.min=selectedUnit==="percent"?"0":".01";
        el.max=selectedUnit==="percent"?"100":String(key==="H"?20000:5120000);
        render();
      }
    });
    view.element.classList.add("vr-unit-switch");
    slot.replaceWith(view.element);unitSwitches[key]=view;
  }
  function fromText(key,raw){
    if(!String(raw).trim())return null;
    const unit=getUnit(key);
    if(unit!=="note"&&!/^-?\d+(?:\.\d{0,2})?$/.test(String(raw)))return null;
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
  const displayValue=key=>key==="H"||key==="F"?
    String(frequencyBindings[key].display(2)):String(state[key]);
  let activePlan=null,lastFingerprint="",generation=0;
  const error=$("#vr-error");
  function render(){
    const keep=$("#vr-placement").value==="keep-spacing";
    if(keep)state.H=state.F/state.m;
    controls.H.readOnly=keep;rails.H.disabled=keep;
    root.querySelector('[data-vr-digit="target-h"]').disabled=keep;
    root.querySelectorAll('[data-vr-counter="target-h"]').forEach(b=>b.disabled=keep);
    for(const key of Object.keys(controls)){
      if(key==="H"||key==="F"){
        if(state[key]>scopes[key]){
          scopes[key]=choices.find(value=>value>=state[key])||20000;
        }
        const scopeSelect=$("#vr-"+keyIds[key]+"-scale");
        scopeSelect.value=String(scopes[key]);
        rails[key].max=String(scopes[key]);
        rails[key].setAttribute("aria-valuetext",fmt(state[key],2)+"Hz");
      }
      const el=controls[key];
      if(document.activeElement!==el)el.value=displayValue(key);
      el.setAttribute("aria-invalid","false");
      if(rails[key])rails[key].value=String(key==="H"||key==="F"?
        Math.min(scopes[key],virtualRootRailFromHz(state[key]).position):state[key]);
      if(key==="H"||key==="F")unitSwitches[key].refresh();
    }
    try{
      activePlan=createVirtualRootPlan({
        F:state.F,H:state.H,m:state.m,h1:state.h1,mode:"auto-fold",
        placement:keep?"keep-spacing":"target",count:8
      });
      const p=activePlan;
      const seq=p.outputs.map(row=>fmt(row.gridIndex,3)).join(", ");
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
  const applyRealtime=()=>{
    const version=++generation;
    const p=activePlan;
    if(!p?.capability.rationalStage)return;
    const fp=[p.F,p.H,p.m,p.h1,p.numerator,p.ratio,p.shift,p.placement].join("|");
    if(fp===lastFingerprint)return;
    // Batch rapid slider gestures to one real engine parameter transaction per frame.
    requestAnimationFrame(()=>{
      if(version!==generation||!activePlan||!activePlan.capability.rationalStage)return;
      try{onApply(activePlan);lastFingerprint=fp;error.hidden=true;error.textContent="";}
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
    el.addEventListener("input",()=>changed(key));
    el.addEventListener("change",()=>{changed(key);if(document.activeElement!==el)el.value=displayValue(key);});
    el.addEventListener("blur",()=>{el.value=displayValue(key);el.setAttribute("aria-invalid","false");});
    if(rails[key])rails[key].addEventListener("input",()=>{
      const raw=Number(rails[key].value);
      if(key==="m"||key==="h1")state[key]=Math.round(raw);
      else state[key]=hzFromVirtualRootRail(raw);
      render();applyRealtime();
    });
  }
  for(const button of root.querySelectorAll("[data-vr-counter]")){
    button.addEventListener("click",()=>{
      const key=Object.keys(keyIds).find(k=>keyIds[k]===button.dataset.vrCounter);
      if(!key||controls[key].readOnly)return;
      const unit=getUnit(key);
      if(unit==="note"){
        state[key]=state[key]*2**(Number(button.dataset.delta)/12);
      }else if(unit==="percent"){
        const binding=frequencyBindings[key],rail=binding.descriptor.rail;
        const percent=clamp(rail.toPosition(binding.value)*100+Number(button.dataset.delta),0,100);
        binding.setView(String(percent),{unit:"percent",origin:"typed",notify:false,overflow:"reject"});
      }else{
        const delta=(key==="m"||key==="h1")?1:.01;
        state[key]=Math.round((state[key]+Number(button.dataset.delta)*delta)*100)/100;
      }
      if(key==="m")state[key]=clamp(Math.round(state[key]),1,64);
      if(key==="h1")state[key]=clamp(Math.round(state[key]),-129,129);
      if(key==="H"||key==="F")state[key]=clamp(state[key],.01,key==="H"?20000:5120000);
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
      const slider=rails[key];slider.max=String(requested);
      slider.value=String(Math.min(requested,virtualRootRailFromHz(state[key]).position));
      // Manual range selection is a view change and must not trigger audio.
      if(getUnit(key)==="percent"&&document.activeElement!==controls[key])
        controls[key].value=displayValue(key);
    });
  }
  const pickers=[
    ["source-f",[6,5,4,3,2,1,0,-1,-2],false],
    ["target-h",[4,3,2,1,0,-1,-2],false],
    ["step-m",[1,0],false],["first-index",[2,1,0],true]
  ];
  for(const [id,places,signed] of pickers)
    makeDigitPicker(id,places,signed,$("#vr-"+id),()=>changed(
      Object.keys(keyIds).find(k=>keyIds[k]===id)));
  document.addEventListener("fw:virtual-root-external-change",()=>{
    generation++;lastFingerprint="";
    const old=onCurrent?.();
    if(old&&finite(old.F)&&old.F>0&&finite(old.r)&&old.r>0&&Number.isSafeInteger(old.m)&&old.m>=1&&old.m<=64){
      const first=old.m+old.n;
      if(Number.isSafeInteger(first)&&first>=-129&&first<=129){
        Object.assign(state,{F:old.F,H:old.F*old.r/old.m,m:old.m,h1:first});
        $("#vr-placement").value="target";
      }
    }
    render(); // Loading A/B/Reset is already an existing DSP transaction; never write again.
  });
  render(); // Initial mount never overwrites existing audio settings.
}
