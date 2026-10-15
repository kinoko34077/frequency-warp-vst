/** Pointer/touch positioning and bounded DOM layout clipboard for the opt-in inspector.
 * Interactive components are never cloned or detached; cut/paste reorders
 * existing siblings via CSS order, which preserves their event listeners.
 */
export const POSITION_KEY='frequency-warp:inspector-position:v1';
export const STATIC_UNSAFE='script,style,link,iframe,canvas,audio,video,button,input,select,textarea,form,a,output,details,summary,label,[role="button"],[contenteditable]';
export function isSafeStaticCopy(node){
  return Boolean(node&&node instanceof Element&&node!==document.body
    &&!node.id&&!node.hasAttribute('for')
    &&!node.matches(STATIC_UNSAFE)
    &&!node.querySelector('[id],[for],'+STATIC_UNSAFE));
}
export function initEditorInteractions({host,shadow,choose,getSelected,isPicking,status,selector,setRule,refresh}){
  const head=shadow.querySelector('.head'),menu=document.createElement('div');
  menu.id='fw-context-menu';
  menu.setAttribute('role','menu');
  menu.hidden=true;
  menu.innerHTML='<button type="button" data-context="cut" role="menuitem">✂ 切り取り</button>'
    +'<button type="button" data-context="copy" role="menuitem">⧉ コピー</button>'
    +'<button type="button" data-context="paste" role="menuitem">▣ 貼り付け</button>'
    +'<button type="button" data-context="duplicate" role="menuitem">⊞ 複製</button>';
  shadow.append(menu);
  const rules=document.createElement('style');
  rules.textContent='#fw-context-menu{position:fixed;z-index:10;display:grid;gap:2px;padding:5px;border:1px solid #4c847a;border-radius:9px;background:#122c30;box-shadow:0 8px 30px #000a;min-width:146px}'
    +'#fw-context-menu[hidden]{display:none!important}#fw-context-menu button{width:100%;text-align:left;padding:10px 12px;background:transparent;color:#e8f9ee;border:0;border-radius:5px;font:13px system-ui,sans-serif}'
    +'#fw-context-menu button:hover:not(:disabled){background:#32695b}#fw-context-menu button:disabled{opacity:.4}'
    +':host(.collapsed) #fw-context-menu{display:none!important}';
  shadow.append(rules);
  const storageGet=()=>{try{return JSON.parse(localStorage.getItem(POSITION_KEY)||'null');}catch{return null;}};
  function clampPosition(x,y){
    const rect=host.getBoundingClientRect();
    return {x:Math.max(0,Math.min(Math.max(0,innerWidth-rect.width),x)),
            y:Math.max(0,Math.min(Math.max(0,innerHeight-rect.height),y))};
  }
  function relocate(x,y,persist=true){
    const p=clampPosition(x,y);
    host.style.left=p.x+'px';host.style.top=p.y+'px';
    host.style.right='auto';host.style.bottom='auto';
    if(persist){try{localStorage.setItem(POSITION_KEY,JSON.stringify(p));}catch{}}
    return p;
  }
  const saved=storageGet();if(saved&&Number.isFinite(saved.x)&&Number.isFinite(saved.y))relocate(saved.x,saved.y,false);
  let drag=null;
  head.style.touchAction='none';head.style.cursor='grab';
  head.addEventListener('pointerdown',event=>{
    if(event.button!==0||event.target.closest('button'))return;
    const rect=host.getBoundingClientRect();
    drag={id:event.pointerId,x:event.clientX,y:event.clientY,left:rect.left,top:rect.top};
    head.setPointerCapture(event.pointerId);
    head.style.cursor='grabbing';
    event.preventDefault();
  });
  head.addEventListener('pointermove',event=>{
    if(!drag||event.pointerId!==drag.id)return;
    relocate(drag.left+event.clientX-drag.x,drag.top+event.clientY-drag.y,false);
  });
  function endDrag(event){
    if(!drag||event.pointerId!==drag.id)return;
    const r=host.getBoundingClientRect();relocate(r.left,r.top);
    drag=null;head.style.cursor='grab';
    if(head.hasPointerCapture(event.pointerId))head.releasePointerCapture(event.pointerId);
  }
  head.addEventListener('pointerup',endDrag);head.addEventListener('pointercancel',endDrag);
  window.addEventListener('resize',()=>{
    if(host.style.left){const r=host.getBoundingClientRect();relocate(r.left,r.top,false);}
  });
  shadow.querySelector('[data-action="collapse"]').addEventListener('click',()=>{
    menu.hidden=true;requestAnimationFrame(()=>{
      if(host.style.left){const r=host.getBoundingClientRect();relocate(r.left,r.top);}
    });
  });
  let clipboard=null,pressTimer=null,pressStart=null,suppressClick=false;
  const active=()=>host.isConnected&&!host.hidden&&isPicking();
  const safeParent=el=>Boolean(el?.parentElement&&/flex|grid/.test(getComputedStyle(el.parentElement).display));
  const peers=el=>[...el.parentElement.children].sort((a,b)=>{
    const x=parseInt(getComputedStyle(a).order)||0,y=parseInt(getComputedStyle(b).order)||0;
    return x-y;
  });
  function hideMenu(){menu.hidden=true;}
  function openMenu(x,y,node){
    if(!active()||!node||node===document.body||node===document.documentElement)return;
    choose(node);
    const selected=getSelected();
    if(!selected)return;
    menu.querySelector('[data-context=cut]').disabled=!safeParent(selected);
    menu.querySelector('[data-context=copy]').disabled=!isSafeStaticCopy(selected);
    menu.querySelector('[data-context=paste]').disabled=!clipboard;
    menu.querySelector('[data-context=duplicate]').disabled=!isSafeStaticCopy(selected);
    menu.hidden=false;
    // shadow-fixed menu coordinates are relative to viewport.
    menu.style.left=Math.max(0,Math.min(innerWidth-160,x))+'px';
    menu.style.top=Math.max(0,Math.min(innerHeight-205,y))+'px';
  }
  function copy(node){if(!isSafeStaticCopy(node)){status('操作部品やID付き要素は複製できません。切り取りで同じ親内の表示順を変更できます。');return false;}
    clipboard={kind:'copy',node:node.cloneNode(true)};status('静的要素をコピーしました。貼り付け先を選択してください（複製は再読込で消えます）。');return true;
  }
  function cut(node){if(!safeParent(node)){status('切り取り移動はFlex/Gridの同じ親内だけ対応しています。');return false;}
    clipboard={kind:'cut',node};status('切り取り元を記録しました。貼り付け先を選ぶと安全に表示順が変わります。');return true;
  }
  function paste(target){
    if(!clipboard||!target?.parentElement){status('貼り付け元と貼り付け先を選択してください。');return false;}
    if(clipboard.kind==='cut'){
      const src=clipboard.node;
      if(!src.isConnected||src===target||src.parentElement!==target.parentElement||!safeParent(src)){
        status('既存の操作部品は同じFlex/Grid親内にのみ移動できます。');return false;
      }
      const arr=peers(target).filter(n=>n!==src),at=arr.indexOf(target);
      if(at<0)return false;
      arr.splice(at+1,0,src);
      // The order property is scoped using the inspector's current desktop/mobile selector.
      for(const [i,n] of arr.entries())setRule(selector(n),'order',String(i));
      clipboard=null;choose(src);status('表示順を変更しました。元のボタンの機能は保持されます。');return true;
    }
    if(!isSafeStaticCopy(clipboard.node)){status('この要素は複製できません。');return false;}
    const node=clipboard.node.cloneNode(true);
    node.removeAttribute('data-fw-edit-selected');
    node.removeAttribute('data-fw-edit-hover');
    node.setAttribute('data-fw-inspector-copy','');
    target.after(node);choose(node);status('静的要素を貼り付けました（今の画面のみ。HTML変更はCSS書き出しに含まれません）。');return true;
  }
  function act(name){
    const el=getSelected();let ok=false;
    if(name==='copy')ok=copy(el);
    else if(name==='cut')ok=cut(el);
    else if(name==='paste')ok=paste(el);
    else if(name==='duplicate'){ok=copy(el)&&paste(el);}
    hideMenu();refresh();return ok;
  }
  menu.addEventListener('click',event=>{
    const b=event.target.closest('button[data-context]');if(b&&!b.disabled)act(b.dataset.context);
  });
  document.addEventListener('contextmenu',event=>{
    if(!active()||event.composedPath().includes(host))return;
    const target=event.target instanceof Element?event.target:null;
    if(!target)return;
    event.preventDefault();event.stopImmediatePropagation();openMenu(event.clientX,event.clientY,target);
  },true);
  function cancelLongPress(){if(pressTimer!==null)clearTimeout(pressTimer);pressTimer=null;pressStart=null;}
  document.addEventListener('pointerdown',event=>{
    if(!active()||event.pointerType!=='touch'||event.composedPath().includes(host))return;
    const target=event.target instanceof Element?event.target:null;
    if(!target)return;
    cancelLongPress();
    pressStart={id:event.pointerId,x:event.clientX,y:event.clientY};
    pressTimer=setTimeout(()=>{
      pressTimer=null;openMenu(pressStart?.x??event.clientX,pressStart?.y??event.clientY,target);
      suppressClick=true;pressStart=null;
    },540);
  },true);
  document.addEventListener('pointermove',event=>{
    if(pressStart&&pressStart.id===event.pointerId&&Math.hypot(event.clientX-pressStart.x,event.clientY-pressStart.y)>11)cancelLongPress();
  },true);
  document.addEventListener('pointerup',cancelLongPress,true);
  document.addEventListener('pointercancel',cancelLongPress,true);
  document.addEventListener('scroll',cancelLongPress,true);
  document.addEventListener('click',event=>{
    if(!active())return;
    if(suppressClick){suppressClick=false;event.preventDefault();event.stopImmediatePropagation();return;}
    if(!event.composedPath().includes(host))hideMenu();
  },true);
  document.addEventListener('keydown',event=>{
    if(!active())return;
    if(event.key==='Escape'){hideMenu();return;}
    const target=event.target;
    if(target instanceof Element&&target.closest('input,select,textarea,[contenteditable]'))return;
    if(event.key==='F10'&&event.shiftKey){event.preventDefault();const r=getSelected()?.getBoundingClientRect();if(r)openMenu(r.x+20,r.y+25,getSelected());return;}
    if(!(event.ctrlKey||event.metaKey)||event.altKey)return;
    const key=event.key.toLowerCase();
    if(['x','c','v'].includes(key)&&getSelected()){event.preventDefault();act(key==='x'?'cut':key==='c'?'copy':'paste');}
  },true);
  return {hideMenu,refresh,relocate};
}
