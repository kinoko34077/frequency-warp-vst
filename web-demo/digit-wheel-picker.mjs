/** #276 V6: iOS-style multi-column scroll-snap numeric wheel (Web, NOT native UIKit).
 * Touch inertia is provided by browser scrolling; each column is one digit.
 */
export const WHEEL_ROW_PX=42;
export function splitWheelNumber(value,{signed=false,places=[]}={}){
  if(!Number.isFinite(value))throw RangeError("finite");
  const magnitude=Math.round(Math.abs(value)*100);
  return [...(signed?[value<0?1:0]:[]),...places.map(p=>
    Math.floor(magnitude/10**(p+2))%10)];
}
export function composeWheelNumber(digits,{signed=false,places=[]}={}){
  if(digits.length!==places.length+Number(signed))throw RangeError("digit count");
  const sign=signed&&digits[0]===1?-1:1;
  if(digits.some((d,i)=>!Number.isInteger(d)||d<0||d>(signed&&i===0?1:9)))
    throw RangeError("digits");
  const offset=Number(signed);
  return Number((sign*places.reduce((sum,p,i)=>sum+digits[i+offset]*10**p,0)).toFixed(2));
}
export function createDigitWheelPicker({document:doc=document,onValue,root=doc.body}){
  const overlay=doc.createElement("div");overlay.id="vr-wheel-overlay";
  overlay.className="vr-wheel-overlay";overlay.hidden=true;
  overlay.innerHTML=`<div class="vr-wheel-backdrop" data-wheel-cancel></div>
    <section class="vr-wheel-sheet" role="dialog" aria-modal="true" aria-label="桁ごとの数値入力">
    <header class="vr-wheel-header"><button type="button" data-wheel-cancel>キャンセル</button>
    <span id="vr-wheel-title"></span><button type="button" data-wheel-done>完了</button></header>
    <div class="vr-wheel-scroller"><div id="vr-wheel-columns" class="vr-wheel-columns"></div>
    <div class="vr-wheel-selection" aria-hidden="true"></div></div>
    <output id="vr-wheel-value" class="vr-wheel-value" aria-live="polite"></output></section>`;
  root.append(overlay);
  const columns=overlay.querySelector("#vr-wheel-columns");
  const label=overlay.querySelector("#vr-wheel-title");
  const live=overlay.querySelector("#vr-wheel-value");
  let active=null,original=0,source=null,epoch=0;
  const close=(cancel=false)=>{
    if(overlay.hidden)return;
    ++epoch;
    const prior=active;
    overlay.hidden=true;active=null;columns.replaceChildren();
    doc.removeEventListener("keydown",escape,true);
    if(cancel&&prior)onValue(prior.key,original);
    source?.setAttribute("aria-expanded","false");
    source?.focus();source=null;
  };
  function escape(e){if(e.key==="Escape"){e.preventDefault();e.stopPropagation();close(true);}}
  for(const btn of overlay.querySelectorAll("[data-wheel-cancel]"))
    btn.addEventListener("click",()=>close(true));
  overlay.querySelector("[data-wheel-done]").addEventListener("click",()=>close(false));
  const update=()=>{
    if(!active)return;
    try{
      const value=composeWheelNumber(active.digits,active);
      const accepted=onValue(active.key,value);
      live.textContent=accepted===false?"範囲外":String(value);
      live.dataset.valid=String(accepted!==false);
    }catch{live.textContent="範囲外";live.dataset.valid="false";}
  };
  function makeColumn(place,index,digit,session){
    if(place==="dot"){
      const mark=doc.createElement("div");mark.className="vr-wheel-dot";
      mark.textContent=".";mark.setAttribute("aria-hidden","true");return mark;
    }
    const options=place==="sign"?["+","−"]:Array.from({length:10},(_,n)=>String(n));
    const track=doc.createElement("div");track.className="vr-wheel-track";
    track.tabIndex=0;track.setAttribute("role","spinbutton");
    track.setAttribute("aria-label",place==="sign"?"符号":place<0?"小数第"+(-place)+"位":"10の"+place+"乗の桁");
    track.setAttribute("aria-valuemin","0");track.setAttribute("aria-valuemax",String(options.length-1));
    const pad=doc.createElement("div");pad.className="vr-wheel-pad";
    pad.setAttribute("aria-hidden","true");track.append(pad);
    options.forEach((value,n)=>{
      const item=doc.createElement("div");item.className="vr-wheel-item";item.textContent=value;
      item.dataset.value=String(n);item.setAttribute("aria-hidden","true");
      item.addEventListener("click",()=>track.scrollTo({top:n*WHEEL_ROW_PX,behavior:"smooth"}));
      track.append(item);
    });
    track.append(pad.cloneNode());
    let position=digit,initializing=true;
    const sync=()=>{
      active.digits[index]=position;
      track.setAttribute("aria-valuenow",String(position));
      track.setAttribute("aria-valuetext",options[position]);
      for(const el of track.querySelectorAll(".vr-wheel-item"))
        el.classList.toggle("is-selected",Number(el.dataset.value)===position);
    };
    const setPosition=n=>{
      const next=Math.max(0,Math.min(options.length-1,n));
      if(next===position)return;
      position=next;sync();update();
    };
    track.addEventListener("scroll",()=>{
      if(initializing||!active||epoch!==session)return;
      setPosition(Math.round(track.scrollTop/WHEEL_ROW_PX));
    },{passive:true});
    track.addEventListener("keydown",e=>{
      if(!["ArrowDown","ArrowUp"].includes(e.key))return;
      e.preventDefault();
      const next=Math.max(0,Math.min(options.length-1,position+(e.key==="ArrowDown"?1:-1)));
      track.scrollTop=next*WHEEL_ROW_PX;setPosition(next);
    });
    sync();
    requestAnimationFrame(()=>{
      if(epoch!==session)return;
      track.scrollTop=digit*WHEEL_ROW_PX;
      requestAnimationFrame(()=>{if(epoch===session)initializing=false;});
    });
    return track;
  }
  function open({key,label:heading,value,places,signed=false,trigger}){
    if(active)close();
    const session=++epoch;
    original=value;source=trigger;source.setAttribute("aria-expanded","true");
    active={key,places,signed,digits:splitWheelNumber(value,{places,signed})};
    label.textContent=heading;live.textContent=String(value);live.dataset.valid="true";
    columns.replaceChildren();
    let index=0;
    if(signed)columns.append(makeColumn("sign",index++,active.digits[0],session));
    for(const p of places){
      if(p===-1)columns.append(makeColumn("dot",-1,0,session));
      columns.append(makeColumn(p,index,active.digits[index],session));index++;
    }
    overlay.hidden=false;
    doc.addEventListener("keydown",escape,true);
    overlay.querySelector("[data-wheel-done]").focus();
  }
  return Object.freeze({open,close,isOpen:()=>!overlay.hidden});
}
