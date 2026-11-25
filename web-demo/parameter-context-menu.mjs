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
function showMenu(doc,menu,owner,node,x,y,items,keyboard,avoidHeldPoint=false){
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
  // Do not put the newly opened menu underneath the held finger. Near
  // the lower edge, prefer the space above rather than clamping onto it.
  const preferredY=avoidHeldPoint?
    (y+12+height<=view.innerHeight-8?y+12:y-height-12):y;
  element.style.top=Math.max(8,Math.min(view.innerHeight-height-8,preferredY))+"px";
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
  const open=(node,x,y,keyboard=false,avoidHeldPoint=false)=>{
    if(disposed||node.disabled)return;
    const items=getItems(node);
    if(!Array.isArray(items)||!items.length)return;
    showMenu(doc,menu,owner,node,x,y,items,keyboard,avoidHeldPoint);
  };
  for(const node of targets){
    on(node,"contextmenu",event=>{
      event.preventDefault();event.stopPropagation();
      const heldPoint=pending?.node===node||["touch","pen"].includes(event.pointerType);
      if(suppressClickAfterHold&&heldPoint)suppressTarget=node;
      cancel();open(node,event.clientX,event.clientY,false,heldPoint);
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
        open(node,point.x,point.y,false,true);
      },550);
    });
  }
  if(suppressClickAfterHold){
    // A release-generated click can be retargeted to a menu item which
    // appeared during the hold. Guard at the document, not only the old
    // target. A fresh pointerdown or keyboard gesture is a deliberate action.
    on(doc,"pointerdown",()=>{suppressTarget=null;},true);
    on(doc,"keydown",()=>{suppressTarget=null;},true);
    on(doc,"click",event=>{
      if(!suppressTarget)return;
      const trigger=suppressTarget;
      suppressTarget=null;
      if(!trigger.contains(event.target)&&
        !(menu.owner===owner&&menu.element.contains(event.target)&&event.detail!==0))return;
      event.preventDefault();event.stopImmediatePropagation();
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

// Modifier bypass is gesture-scoped; it never changes the saved ON/OFF state.
const held={alt:false,ctrl:false};
if(typeof window!=="undefined"){
  window.addEventListener("keydown",event=>{held.alt=event.altKey;held.ctrl=event.ctrlKey;},true);
  window.addEventListener("keyup",event=>{held.alt=event.altKey;held.ctrl=event.ctrlKey;},true);
  window.addEventListener("blur",()=>{held.alt=false;held.ctrl=false;});
}
/** Shared snap preference adapter; the context-menu component owns all
 * menu rendering, placement, gestures and teardown. */
export function attachParameterSnapControls({doc,targets,defaultEnabled=true}){
  if(!doc||!Array.isArray(targets)||!targets.length)
    throw new TypeError("snap controls require a document and targets");
  let snapEnabled=Boolean(defaultEnabled),disposed=false;
  const originals=targets.map(node=>({
    node,title:node.title,ariaDescription:node.getAttribute("aria-description"),
    dataSnap:node.dataset.fwSnap,hadControl:node.hasAttribute("data-fw-snap-control")
  }));
  const updateHints=()=>{
    if(disposed)return;
    for(const node of targets){
      node.dataset.fwSnap=snapEnabled?"on":"off";
      node.setAttribute("data-fw-snap-control","");
      const hint="吸着: "+(snapEnabled?"ON":"OFF")+
        "。長押し／右クリックで切替。AltまたはCtrlを押しながら操作すると一時OFF";
      if(!node.matches("button[data-unit]"))node.title=hint;
      node.setAttribute("aria-description",hint);
    }
  };
  const setSnapEnabled=enabled=>{
    if(disposed)return;
    snapEnabled=Boolean(enabled);updateHints();
  };
  const context=attachParameterContextMenu({doc,targets,getItems:()=>[{
    label:snapEnabled?"吸着をオフにする":"吸着をオンにする",
    role:"menuitemcheckbox",checked:snapEnabled,onSelect:()=>setSnapEnabled(!snapEnabled)
  }]});
  updateHints();
  return Object.freeze({
    get enabled(){return snapEnabled;},
    setEnabled:setSnapEnabled,
    gestureEnabled:event=>!disposed&&snapEnabled&&
      !(held.alt||held.ctrl||event?.altKey||event?.ctrlKey),
    dispose(){
      if(disposed)return;
      disposed=true;context.dispose();
      for(const {node,title,ariaDescription,dataSnap,hadControl} of originals){
        node.title=title;
        if(ariaDescription===null)node.removeAttribute("aria-description");
        else node.setAttribute("aria-description",ariaDescription);
        if(dataSnap===undefined)delete node.dataset.fwSnap;
        else node.dataset.fwSnap=dataSnap;
        if(!hadControl)node.removeAttribute("data-fw-snap-control");
      }
    }
  });
}
