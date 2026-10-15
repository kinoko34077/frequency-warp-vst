import {STORAGE_KEY,sanitizeRule,normalizeChanges,cssForChanges,moveSibling} from './visual-editor-core.mjs';
import {initEditorInteractions} from './visual-editor-interactions.mjs';
/** Only loaded with ?layout_editor=1. Changes remain on this browser until exported. */
if(new URL(location.href).searchParams.get('layout_editor')==='1'||localStorage.getItem('frequency-warp:debug-mode:v1')==='1'){
  const host=document.createElement('aside');host.id='fw-layout-inspector';document.body.append(host);
  const shadow=host.attachShadow({mode:'open'});
  const style=document.createElement('style');style.id='fw-layout-overrides';document.head.append(style);
  const outline=document.createElement('style');outline.textContent='[data-fw-edit-selected]{outline:2px solid #70efc4!important;outline-offset:3px!important}[data-fw-edit-hover]{outline:1px dashed #ffca7a!important;outline-offset:2px!important}';document.head.append(outline);
  let changes=normalizeChanges(null);
  try{changes=normalizeChanges(JSON.parse(localStorage.getItem(STORAGE_KEY)||'null'));}catch{}
  let selected=null,hovered=null,picking=true,scope='global';
  const numberControls=[['width','幅'],['height','高さ'],['padding','内側余白'],['margin','外側余白'],['gap','要素間隔'],['border-radius','角丸'],['font-size','文字サイズ']];
  const fields=numberControls.map(x=>'<label>'+x[1]+'<input type="number" step="1" min="0" max="3000" placeholder="auto" data-prop="'+x[0]+'"></label>').join('');
  shadow.innerHTML='<style>'+
   ':host{all:initial;position:fixed!important;z-index:2147483646!important;bottom:12px;right:12px;color:#e2f5eb;font:12px/1.5 system-ui,sans-serif}'+
   '*{box-sizing:border-box}.panel{width:min(335px,calc(100vw - 24px));max-height:min(92dvh,850px);overflow:auto;background:#112a2e;border:1px solid #40665f;border-radius:12px;padding:13px;box-shadow:0 18px 40px #000b;display:flex;flex-direction:column;gap:10px}'+
   '.head{display:flex;align-items:center;justify-content:space-between}.head strong{color:#81f0ca;font-size:15px}'+
   '.actions,.foot{display:flex;gap:5px;flex-wrap:wrap}.actions button,.foot button{flex:1}button{cursor:pointer;background:#224a42;color:#f0fff7;border:1px solid #477b6f;border-radius:7px;padding:7px;font:inherit}button:hover{background:#32665a}button:disabled{opacity:.38;cursor:not-allowed}button[aria-pressed=true]{background:#71ddb8;color:#0d2e25}'+
   'input,select{width:100%;min-width:0;color:#e9fff6;background:#091c21;border:1px solid #46655c;border-radius:6px;padding:7px;font:inherit}button:focus-visible,input:focus-visible,select:focus-visible{outline:2px solid #a0e8ff}'+
   'label{display:flex;flex-direction:column;gap:3px;color:#b4d7ce}.grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}'+
   '.path{font:11px ui-monospace,monospace;background:#081e23;padding:7px;border-radius:5px;overflow-wrap:anywhere;max-height:65px;overflow:auto}.scope{display:flex;align-items:center;gap:8px}.scope span{flex:1}.scope select{flex:2}'+
   '.status{font-size:11px;color:#81e4bc;min-height:16px}.hint{font-size:10px;color:#9ac0b8}:host(.collapsed) .panel>:not(.head){display:none!important}:host(.collapsed) .panel{width:180px;max-height:none}'+
   '@media(max-width:480px){:host{bottom:8px;right:8px}.panel{max-height:60dvh}}'+
   '</style><div class="panel"><div class="head"><strong>∿ Layout Inspector</strong><button data-action="collapse" aria-label="最小化">−</button></div>'+
   '<div class="actions"><button data-action="pick" aria-pressed="true">要素を選択</button><button data-action="preview" aria-pressed="false">動作確認</button><button data-action="parent">親要素 ↑</button></div>'+
   '<div class="path" id="path">ページ上の要素をクリックして選択</div>'+
   '<div class="scope"><span>CSSの適用範囲</span><select id="scope"><option value="global">全画面</option><option value="mobile">スマホのみ（800px以下）</option></select></div>'+
   '<div class="grid">'+fields+
   '<label>幅の単位<select id="width-unit"><option value="px">px</option><option value="%">%</option></select></label>'+
   '<label>背景色<input type="color" data-prop="background-color" value="#10282c"></label>'+
   '<label>文字色<input type="color" data-prop="color" value="#e2f5eb"></label></div>'+
   '<div class="actions"><button data-action="up">前へ</button><button data-action="down">後へ</button><button data-action="clear">選択要素を戻す</button></div>'+
   '<div class="foot"><button data-action="copy">CSSコピー</button><button data-action="download">CSS保存</button><button data-action="reset">全消去</button></div>'+
   '<div class="hint">実ページのDOMを編集します。変更はこのブラウザだけに保存され、GitHubへ自動送信しません。ドラッグ中や再生中は「動作確認」を使用してください。</div><div class="status" id="status" role="status"></div></div>';
  const ui=id=>shadow.getElementById(id);
  const status=m=>{ui('status').textContent=m;};
  function selector(el){
    if(!el||el===document.body||el===document.documentElement)return '';
    const parts=[];let n=el;
    while(n&&n!==document.body){
      if(n.id){parts.unshift('#'+CSS.escape(n.id));break;}
      let p=n.localName;
      const cl=[...n.classList].find(c=>!c.startsWith('fw-'));if(cl)p+='.'+CSS.escape(cl);
      const same=[...n.parentElement.children].filter(s=>s.localName===n.localName);
      if(same.length>1)p+=':nth-of-type('+String(same.indexOf(n)+1)+')';
      parts.unshift(p);n=n.parentElement;
    }
    return parts.join(' > ');
  }
  function save(){
    changes=normalizeChanges(changes);style.textContent=cssForChanges(changes);
    try{localStorage.setItem(STORAGE_KEY,JSON.stringify(changes));}catch{status('自動保存不可：CSSを別途書き出してください。');}
  }
  function setRule(path,prop,value){
    if(!path)return;const item=changes[scope][path]||(changes[scope][path]={});
    const safe=sanitizeRule(prop,value);
    if(safe===null)delete item[prop];else item[prop]=safe;
    if(!Object.keys(item).length)delete changes[scope][path];
    save();
  }
  function rgb(v){
    if(/^#[a-f0-9]{6}$/i.test(v))return v;
    const m=/rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/i.exec(v);
    return m?'#'+[m[1],m[2],m[3]].map(n=>Number(n).toString(16).padStart(2,'0')).join(''):'#000000';
  }
  function ordered(){
    if(!selected||!selected.parentElement)return [];
    const parent=selected.parentElement;
    if(!/flex|grid/.test(getComputedStyle(parent).display))return [];
    return [...parent.children].sort((a,b)=>{
      const x=Number(changes[scope][selector(a)]?.order??getComputedStyle(a).order??0);
      const y=Number(changes[scope][selector(b)]?.order??getComputedStyle(b).order??0);
      return x-y;
    });
  }
  function refresh(){
    if(selected&&!document.contains(selected))selected=null;
    const s=selected?selector(selected):'';
    ui('path').textContent=s||'ページ上の要素をクリックして選択';
    shadow.querySelector('[data-action=parent]').disabled=!selected||selected.parentElement===document.body;
    for(const input of shadow.querySelectorAll('[data-prop]')){
      input.disabled=!selected;
      if(!selected){if(input.type==='number')input.value='';continue;}
      const prop=input.dataset.prop;
      const value=changes[scope][s]?.[prop]??getComputedStyle(selected).getPropertyValue(prop).trim();
      if(input.type==='color')input.value=rgb(value);
      else{const m=/^(\d+(?:\.\d+)?)(px|%)$/.exec(value);input.value=m?m[1]:'';if(prop==='width'&&m)ui('width-unit').value=m[2];}
    }
    const list=ordered(),index=list.indexOf(selected);
    shadow.querySelector('[data-action=up]').disabled=index<=0;
    shadow.querySelector('[data-action=down]').disabled=index<0||index>=list.length-1;
  }
  function choose(el){
    if(selected)selected.removeAttribute('data-fw-edit-selected');
    selected=el&&el!==document.body&&el!==document.documentElement&&document.contains(el)?el:null;
    if(selected)selected.setAttribute('data-fw-edit-selected','');
    refresh();
  }
  function isSettingsAction(event){
    const target=event.target;
    return target instanceof Element&&Boolean(target.closest('#settings-dialog,#settings-open,#settings-inline'));
  }
  function pick(enabled){
    picking=enabled;
    shadow.querySelector('[data-action=pick]').setAttribute('aria-pressed',String(enabled));
    shadow.querySelector('[data-action=preview]').setAttribute('aria-pressed',String(!enabled));
    if(hovered)hovered.removeAttribute('data-fw-edit-hover');hovered=null;
    status(enabled?'要素をクリックして編集してください。':'通常の音声操作ができます。');
  }
  document.addEventListener('click',event=>{
    if(!picking||host.hidden||event.composedPath().includes(host)||isSettingsAction(event))return;
    event.preventDefault();event.stopImmediatePropagation();
    choose(event.target instanceof Element?event.target:event.target.parentElement);
  },true);
  document.addEventListener('pointerover',event=>{
    if(!picking||host.hidden||event.composedPath().includes(host)||isSettingsAction(event))return;
    if(hovered)hovered.removeAttribute('data-fw-edit-hover');
    hovered=event.target instanceof Element?event.target:null;
    if(hovered&&hovered!==document.body)hovered.setAttribute('data-fw-edit-hover','');
  },true);
  document.addEventListener('keydown',event=>{if(event.key==='Escape'&&picking)pick(false);},true);
  shadow.addEventListener('input',event=>{
    const input=event.target.closest('[data-prop]');if(!input||!selected)return;
    const prop=input.dataset.prop;
    const val=input.type==='color'?input.value:(input.value.trim()?input.value+(prop==='width'?ui('width-unit').value:'px'):'');
    setRule(selector(selected),prop,val);
  });
  ui('width-unit').addEventListener('change',()=>{const input=shadow.querySelector('[data-prop=width]');if(selected&&input.value)setRule(selector(selected),'width',input.value+ui('width-unit').value);});
  ui('scope').addEventListener('change',event=>{scope=event.target.value;refresh();if(scope==='mobile'&&innerWidth>800)status('スマホ指定は幅800px以下の画面で反映されます。');});
  shadow.addEventListener('click',async event=>{
    const button=event.target.closest('button[data-action]');if(!button)return;
    const action=button.dataset.action;
    if(action==='pick')return pick(true);
    if(action==='preview')return pick(false);
    if(action==='collapse'){host.classList.toggle('collapsed');button.textContent=host.classList.contains('collapsed')?'+':'−';return;}
    if(action==='parent'){if(selected&&selected.parentElement!==document.body)choose(selected.parentElement);return;}
    if(action==='up'||action==='down'){
      const orderedNodes=ordered(),current=selected&&selector(selected);
      const paths=orderedNodes.map(selector);
      if(new Set(paths).size!==paths.length){status('要素の識別が重複したため並べ替えできません。');return;}
      const moved=moveSibling(paths,current,action==='up'?-1:1);if(!moved)return;
      moved.forEach((name,index)=>setRule(name,'order',String(index)));
      refresh();status('表示順を変更しました（DOM順は維持）。');return;
    }
    if(action==='clear'){if(selected)delete changes[scope][selector(selected)];save();refresh();return;}
    if(action==='reset'){
      if(!confirm('このブラウザで保存したレイアウト変更をすべて削除しますか？'))return;
      changes=normalizeChanges(null);save();refresh();status('レイアウト変更を消去しました。');return;
    }
    if(action==='copy'||action==='download'){
      const css='/* Frequency Warp layout overrides: review before production */\n'+cssForChanges(changes)+'\n';
      if(action==='copy'){
        try{await navigator.clipboard.writeText(css);status('CSSをコピーしました。');}catch{status('コピーできませんでした。CSS保存を利用してください。');}
      }else{
        const url=URL.createObjectURL(new Blob([css],{type:'text/css'}));
        const link=document.createElement('a');link.href=url;link.download='frequency-warp-layout-overrides.css';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);status('CSSファイルを保存しました。');
      }
    }
  });
  const interactions=initEditorInteractions({host,shadow,choose,getSelected:()=>selected,isPicking:()=>picking,status,selector,setRule,refresh});
  window.addEventListener('fw:debug-change',event=>{
    const enabled=Boolean(event.detail?.enabled);
    host.hidden=!enabled;
    if(!enabled){
      pick(false);
      interactions.hideMenu();
      if(selected)selected.removeAttribute('data-fw-edit-selected');
      if(hovered)hovered.removeAttribute('data-fw-edit-hover');
      selected=null;hovered=null;
    }else pick(true);
  });
  save();refresh();status('要素をクリックして編集できます。');
}