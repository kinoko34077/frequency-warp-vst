/** Shared parameter context menu: one transient DOM menu per document.
 * Extends the former snap-only menu; caller supplies labels/selection semantics.
 */
const menus=new WeakMap();
function closeMenu(menu,restoreFocus=false){
  const trigger=menu.trigger;
  menu.element.hidden=true;menu.owner=null;menu.trigger=null;
  menu.element.replaceChildren();
  if(restoreFocus)trigger?.focus();
}
function getMenu(doc){
  if(menus.has(doc))return menus.get(doc);
  const element=doc.createElement("div");
  element.id="fw-unit-snap-menu";element.hidden=true;element.setAttribute("role","menu");
  doc.body.append(element);
  const menu={element,owner:null,trigger:null};menus.set(doc,menu);
  doc.addEventListener("pointerdown",event=>{
    if(!element.hidden&&!element.contains(event.target))closeMenu(menu);
  },true);
  doc.addEventListener("keydown",event=>{
    if(element.hidden)return;
    if(event.key==="Escape"){
      closeMenu(menu,element.contains(doc.activeElement));event.preventDefault();
      event.stopPropagation();return;
    }
    if(!element.contains(doc.activeElement)||!["ArrowDown","ArrowUp","Home","End"].includes(event.key))return;
    const items=[...element.querySelectorAll("button:not([disabled])")];
    if(!items.length)return;
    const index=items.indexOf(doc.activeElement);
    const next=event.key==="Home"?0:event.key==="End"?items.length-1:
      (index+(event.key==="ArrowDown"?1:-1)+items.length)%items.length;
    items[next].focus();event.preventDefault();
  },true);
  return menu;
}
function showMenu(doc,menu,owner,node,x,y,items,keyboard){
  const element=menu.element;
  const container=node.closest("dialog[open]")||doc.body;
  if(element.parentNode!==container)container.append(element);
  closeMenu(menu);
  menu.owner=owner;menu.trigger=node;
  for(const item of items){
    const button=doc.createElement("button");
    button.type="button";button.textContent=item.label;
    button.setAttribute("role",item.role||"menuitem");
    if(item.checked!==undefined)button.setAttribute("aria-checked",String(Boolean(item.checked)));
    button.disabled=Boolean(item.disabled);
    button.addEventListener("click",()=>{
      if(menu.owner!==owner||button.disabled)return;
      const restore=element.contains(doc.activeElement)&&keyboard;
      closeMenu(menu,restore);item.onSelect();
    });
    element.append(button);
  }
  element.hidden=false;
  const view=doc.defaultView||window;
  const width=element.offsetWidth||180,height=element.offsetHeight||48;
  element.style.left=Math.max(8,Math.min(view.innerWidth-width-8,x))+"px";
  element.style.top=Math.max(8,Math.min(view.innerHeight-height-8,y))+"px";
  if(keyboard)element.querySelector("button:not([disabled])")?.focus();
}
export function attachParameterContextMenu({doc,targets,getItems,suppressClickAfterHold=false}){
  if(!doc||!Array.isArray(targets)||!targets.length||typeof getItems!=="function")
    throw new TypeError("parameter context menu requires document, targets and getItems");
  const menu=getMenu(doc),owner=Symbol("parameter-context-menu"),unsubscribers=[];
  let disposed=false,pending=null,suppressTarget=null;
  const on=(node,type,listener,options)=>{
    node.addEventListener(type,listener,options);
    unsubscribers.push(()=>node.removeEventListener(type,listener,options));
  };
  const cancel=()=>{
    if(pending?.timer!==null&&pending?.timer!==undefined)clearTimeout(pending.timer);
    pending=null;
  };
  const open=(node,x,y,keyboard=false)=>{
    if(disposed||node.disabled)return;
    const items=getItems(node);
    if(!Array.isArray(items)||!items.length)return;
    showMenu(doc,menu,owner,node,x,y,items,keyboard);
  };
  for(const node of targets){
    on(node,"contextmenu",event=>{
      event.preventDefault();event.stopPropagation();
      if(suppressClickAfterHold&&(pending?.node===node||["touch","pen"].includes(event.pointerType)))
        suppressTarget=node;
      cancel();open(node,event.clientX,event.clientY);
    });
    on(node,"keydown",event=>{
      if(event.key!=="ContextMenu"&&!(event.shiftKey&&event.key==="F10"))return;
      event.preventDefault();event.stopPropagation();
      const r=node.getBoundingClientRect();open(node,r.left+12,r.bottom+4,true);
    });
    on(node,"pointerdown",event=>{
      suppressTarget=null;
      if(!["touch","pen"].includes(event.pointerType)||event.button!==0||node.disabled)return;
      cancel();
      const point={id:event.pointerId,x:event.clientX,y:event.clientY,node,timer:null};
      pending=point;
      point.timer=setTimeout(()=>{
        if(disposed||pending!==point)return;
        pending=null;
        if(suppressClickAfterHold)suppressTarget=node;
        open(node,point.x,point.y);
      },550);
    });
    if(suppressClickAfterHold)on(node,"click",event=>{
      if(suppressTarget!==node)return;
      suppressTarget=null;event.preventDefault();event.stopImmediatePropagation();
    },true);
  }
  // Observe one active gesture per controller, not per target.
  on(doc,"pointermove",event=>{
    if(pending&&pending.id===event.pointerId&&
       Math.hypot(event.clientX-pending.x,event.clientY-pending.y)>10)cancel();
  },true);
  on(doc,"pointerup",event=>{if(pending?.id===event.pointerId)cancel();},true);
  on(doc,"pointercancel",event=>{if(pending?.id===event.pointerId)cancel();},true);
  on(doc,"scroll",cancel,true);
  return Object.freeze({dispose(){
    if(disposed)return;
    disposed=true;cancel();suppressTarget=null;
    for(const unsubscribe of unsubscribers)unsubscribe();
    if(menu.owner===owner)closeMenu(menu);
  }});
}
