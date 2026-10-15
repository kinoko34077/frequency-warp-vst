import {VisualEditSession,EditError} from './core.mjs';
import {createDomStyleAdapter} from './dom-adapter.mjs';
import {resolvePageProfile} from './profiles.mjs';
import {exportCss,createSourceProposal} from './export.mjs';
/** M1 pilot only. Legacy Frequency Warp inspector remains the production fallback. */
export async function mountVisualEditor({
  nodeMap,root=document.body,target={appId:'frequency-warp',routeId:'main',templateId:'web-ui',sourceRevision:'web-layout-v1'},
  storageKey='frequency-warp:visual-editor-v2:v1'
}={}){
  if(!nodeMap||!root)throw new EditError('BAD_ADAPTER');
  const profile=resolvePageProfile({target,ownership:'static-dom',sourceNodeMap:nodeMap,requiredOperations:['style.safe']});
  const map=Object.entries(profile.sourceNodeMap);
  for(const [name,domId] of map){
    const element=document.getElementById(domId);
    if(element)element.setAttribute('data-ve-id',name);
  }
  const sheet=document.createElement('style');sheet.setAttribute('data-ve-overrides','');document.head.append(sheet);
  const adapter=createDomStyleAdapter({root,styleElement:sheet,target,allowedIds:map.map(([id])=>id),breakpoints:profile.breakpoints});
  const host=document.createElement('aside');host.id='visual-editor-v2';document.body.append(host);
  const shadow=host.attachShadow({mode:'open'});
  shadow.innerHTML='<style>'+
   ':host{all:initial;position:fixed;right:12px;bottom:12px;z-index:2147483646;color:#d9fff4;font:13px system-ui}'+
   '*{box-sizing:border-box}.panel{width:min(290px,calc(100vw - 24px));padding:12px;background:#142e33;border:1px solid #487767;border-radius:10px;box-shadow:0 8px 30px #0008}'+
   'label{display:block;margin-top:7px}select,input,button{font:inherit;padding:7px;background:#244e48;color:inherit;border:1px solid #487e73;border-radius:5px}select,input{width:100%}button{cursor:pointer}button:focus-visible{outline:2px solid #bbf}'+
   '.buttons{display:flex;gap:5px;margin:9px 0;flex-wrap:wrap}.buttons button{flex:1}.small{font-size:11px;color:#abccc4}'+
   '</style><div class="panel"><strong>Visual Editor v2 · pilot</strong>'+
   '<div class="buttons"><button id="pick">選択</button><button id="preview">動作確認</button></div>'+
   '<label>対象<select id="node"></select></label>'+
   '<label>項目<select id="prop"><option value="width">幅</option><option value="height">高さ</option><option value="padding">余白</option><option value="font-size">文字サイズ</option><option value="background-color">背景色</option><option value="color">文字色</option></select></label>'+
   '<label>値<input id="value" placeholder="80% / 18px / #aabbcc"></label>'+
   '<label>画面<select id="bp"><option value="base">共通</option><option value="mobile">スマホ</option></select></label>'+
   '<div class="buttons"><button id="apply">反映</button><button id="clear">項目を戻す</button></div>'+
   '<div class="buttons"><button id="undo">元に戻す</button><button id="redo">やり直し</button></div>'+ 
   '<div class="buttons"><button id="exportcss">CSS書出し</button><button id="exportpatch">変更提案JSON</button></div>'+
   '<div class="small">このブラウザ内だけ保存。動作確認中は画面を透過します。再編集はAlt+Shift+L、または再読込。</div><div id="status" role="status" class="small"></div></div>';
  const el=id=>shadow.getElementById(id);
  const report=message=>{el('status').textContent=message;};
  let session;
  try{session=VisualEditSession.restore({target,adapter,storage:localStorage,storageKey});await session.refresh();}
  catch(err){report('保存済みデータが互換性なし: '+String(err.code??err.message));session=new VisualEditSession({target,adapter});}
  const valid=map.filter(([id])=>{try{adapter.resolve(id);return true}catch{return false}});
  for(const [id] of valid){const opt=document.createElement('option');opt.value=id;opt.textContent=id;el('node').append(opt);}
  let picking=false;
  function mode(value){picking=value;host.style.pointerEvents=value?'auto':'none';el('pick').disabled=picking;el('preview').disabled=!picking;report(picking?'画面上の要素を選択できます':'プレビュー中：Alt+Shift+Lで再編集できます');}
  mode(true);
  window.addEventListener('keydown',event=>{
    if(event.altKey&&event.shiftKey&&event.code==='KeyL'){
      event.preventDefault();mode(!picking);
    }
  });
  el('pick').addEventListener('click',()=>mode(true));
  el('preview').addEventListener('click',()=>mode(false));
  document.addEventListener('click',event=>{
    if(!picking||event.composedPath().includes(host))return;
    const item=event.target instanceof Element?event.target.closest('[data-ve-id]'):null;
    if(!item||!valid.some(([id])=>id===item.getAttribute('data-ve-id')))return;
    event.preventDefault();event.stopImmediatePropagation();
    el('node').value=item.getAttribute('data-ve-id');report('選択: '+el('node').value);
  },true);
  async function change(kind){
    const op={kind,nodeId:el('node').value,property:el('prop').value,breakpoint:el('bp').value};
    if(kind==='setStyle')op.value=el('value').value;
    try{await session.transact({expectedRevision:session.document.designRevision,operations:[op]});report('変更を保存しました');}
    catch(e){report('反映不可: '+String(e.code??e.message));}
  }
  el('apply').addEventListener('click',()=>change('setStyle'));
  el('clear').addEventListener('click',()=>change('removeStyle'));
  el('undo').addEventListener('click',async()=>{try{await session.undo();report('取り消しました');}catch(e){report(String(e.code??e.message));}});
  el('redo').addEventListener('click',async()=>{try{await session.redo();report('やり直しました');}catch(e){report(String(e.code??e.message));}});
  function download(name,mime,data){
    const blob=new Blob([data],{type:mime}),url=URL.createObjectURL(blob);
    const link=document.createElement('a');link.href=url;link.download=name;
    document.body.append(link);link.click();link.remove();
    // Defer revocation until the browser has handed the Blob to its download subsystem.
    setTimeout(()=>URL.revokeObjectURL(url),2000);
  }
  el('exportcss').addEventListener('click',()=>{
    try{download('visual-editor-overrides.css','text/css;charset=utf-8',exportCss(session.document,profile));report('CSSを書き出しました。原本には未反映です');}
    catch(e){report('書き出し不可: '+String(e.code??e.message));}
  });
  el('exportpatch').addEventListener('click',()=>{
    try{download('visual-editor-proposal.json','application/json;charset=utf-8',JSON.stringify(createSourceProposal(session.document,profile),null,2));report('レビュー用変更提案を書き出しました。GitHubには未反映です');}
    catch(e){report('書き出し不可: '+String(e.code??e.message));}
  });
  return {host,session,adapter,profile};
}
