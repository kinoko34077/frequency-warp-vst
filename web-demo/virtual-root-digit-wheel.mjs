/** #276 V6: one iOS-style grouped decimal wheel for Web (not UIKit).
 * Independently scrollable digit columns, bounded value and live callbacks.
 * Each column is a keyboard-accessible listbox with a selected center row.
 */
const HEIGHT=42;
const pad=document.createElement("div");
function fixed(value,decimals){return Math.abs(value).toFixed(decimals);}
function integerPlaces(value,max){
  const int=Math.max(0,Math.floor(Math.abs(value))),limit=Math.max(1,Math.floor(max));
  const digits=Math.min(String(limit).length,Math.max(1,String(int).length+1));
  return Array.from({length:digits},(_,i)=>digits-i-1);
}
const number=(v,d)=>Number(v.toFixed(d));
export function mountDigitWheel({sheet,onChange}){
  if(!sheet||typeof onChange!=="function")throw TypeError("wheel host/callback required");
  sheet.className="vr-wheel-sheet";
  sheet.hidden=true;
  sheet.innerHTML=`<div class="vr-wheel-backdrop" data-vr-wheel-dismiss></div>
    <section class="vr-wheel-panel" role="dialog" aria-modal="true" aria-label="桁ごとの数値入力">
      <div class="vr-wheel-toolbar">
        <span id="vr-wheel-title"></span>
        <div class="vr-wheel-actions">
          <button type="button" id="vr-wheel-keyboard">直接入力</button>
          <button type="button" id="vr-wheel-done">完了</button>
        </div>
      </div>
      <div class="vr-wheel-viewport">
        <div class="vr-wheel-active-band" aria-hidden="true"></div>
        <div class="vr-wheel-columns" id="vr-wheel-columns"></div>
      </div>
    </section>`;
  document.body.append(sheet);
  let current=null,columns=[],syncing=false;
  const area=sheet.querySelector("#vr-wheel-columns");
  const valueOf=()=>{
    let total=0,sign=1;
    for(const col of columns){
      const v=Number(col.el.dataset.value);
      if(col.place==="sign"){sign=v?-1:1;continue;}
      total+=v*10**col.place;
    }
    return number(sign*total,current.decimals);
  };
  const setSelection=(col,index,scroll=true)=>{
    col.index=Math.max(0,Math.min(col.options.length-1,index));
    col.el.dataset.value=col.options[col.index].value;
    col.el.setAttribute("aria-valuenow",col.options[col.index].value);
    col.el.setAttribute("aria-valuetext",col.options[col.index].text);
    col.items.forEach((item,i)=>{
      item.setAttribute("aria-selected",String(i===col.index));
      item.classList.toggle("is-selected",i===col.index);
    });
    if(scroll)col.el.scrollTop=HEIGHT*col.index;
  };
  const update=()=>{
    if(!current||syncing)return;
    const result=valueOf();
    if(result<current.min||result>current.max)return;
    current.value=result;
    onChange(current.key,result);
  };
  const appendColumn=(place,options,selected)=>{
    const el=document.createElement("div");
    el.className="vr-wheel-column";el.setAttribute("role","listbox");
    el.tabIndex=0;
    el.setAttribute("aria-label",place==="sign"?"符号":
      place<0?"小数第"+Math.abs(place)+"位":"10の"+place+"乗の桁");
    const items=[];
    for(const [i,opt] of options.entries()){
      const item=document.createElement("div");item.className="vr-wheel-digit";item.dataset.value=opt.value;
      item.setAttribute("role","option");item.textContent=opt.text;el.append(item);items.push(item);
      item.addEventListener("click",()=>{
        setSelection(col,i);
        update();
      });
    }
    const col={el,place,options,items,index:0,timer:null};
    setSelection(col,selected,false);
    el.addEventListener("scroll",()=>{
      if(syncing)return;
      if(col.timer)clearTimeout(col.timer);
      col.timer=setTimeout(()=>{
        const next=Math.max(0,Math.min(options.length-1,Math.round(el.scrollTop/HEIGHT)));
        const changed=next!==col.index;
        setSelection(col,next);
        if(changed)update();
      },85);
    },{passive:true});
    el.addEventListener("keydown",event=>{
      if(event.key==="ArrowDown"||event.key==="ArrowUp"){
        event.preventDefault();
        setSelection(col,col.index+(event.key==="ArrowDown"?1:-1));
        update();
      }else if(event.key==="Home"||event.key==="End"){
        event.preventDefault();
        setSelection(col,event.key==="Home"?0:options.length-1);
        update();
      }else if(event.key==="Escape"){event.preventDefault();close();}
    });
    area.append(el);columns.push(col);
  };
  const close=()=>{
    if(!current)return;
    const restore=current.trigger;
    current=null;
    for(const col of columns){if(col.timer)clearTimeout(col.timer);}
    area.replaceChildren();columns=[];sheet.hidden=true;
    restore?.focus({preventScroll:true});
  };
  sheet.querySelector("#vr-wheel-done").addEventListener("click",close);
  sheet.querySelector("[data-vr-wheel-dismiss]").addEventListener("click",close);
  sheet.querySelector("#vr-wheel-keyboard").addEventListener("click",()=>{
    const target=current?.input;close();
    target?.focus({preventScroll:true});target?.select();
  });
  document.addEventListener("keydown",event=>{
    if(!sheet.hidden&&event.key==="Escape"){event.preventDefault();close();}
  });
  return Object.freeze({
    get isOpen(){return !sheet.hidden;},
    get key(){return current?.key||null;},
    close,
    open({key,title,value,min,max,decimals=0,signed=false,trigger,input}){
      if(!Number.isFinite(value)||!Number.isFinite(min)||!Number.isFinite(max)||decimals<0||decimals>2)
        throw RangeError("invalid digit wheel source");
      close();
      current={key,title,value,min,max,decimals,signed,trigger,input};
      sheet.hidden=false;sheet.querySelector("#vr-wheel-title").textContent=title;
      area.replaceChildren();columns=[];syncing=true;
      const abs=fixed(value,decimals);
      const [int,frac=""]=abs.split(".");
      if(signed)appendColumn("sign",[{value:"0",text:"+"},{value:"1",text:"−"}],value<0?1:0);
      const places=integerPlaces(value,max);
      for(const place of places){
        const digit=Number(int.padStart(places[0]+1,"0").at(-(place+1)));
        appendColumn(place,Array.from({length:10},(_,i)=>({value:String(i),text:String(i)})),digit);
      }
      if(decimals){
        const dot=document.createElement("span");dot.className="vr-wheel-dot";dot.textContent=".";dot.setAttribute("aria-hidden","true");
        area.append(dot);
        for(let i=0;i<decimals;i++)
          appendColumn(-i-1,Array.from({length:10},(_,n)=>({value:String(n),text:String(n)})),Number(frac[i]||0));
      }
      for(const col of columns)col.el.scrollTop=col.index*HEIGHT;
      requestAnimationFrame(()=>{syncing=false;});
    }
  });
}
