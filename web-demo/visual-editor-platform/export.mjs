import {EditError,validateDocument,assertSafeId} from './core.mjs';
import {resolvePageProfile} from './profiles.mjs';
const fail=code=>{throw new EditError(code);};
const escapeRegExp=s=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
const attrSelector=(key,value)=>'['+key+'="'+value+'"]';
function validated(document,profile){
  if(!profile||profile.ownership!=='static-dom'||profile.adapter!=='dom-style')fail('UNSUPPORTED_EXPORT');
  const safe=validateDocument(document,profile.target);
  const found=new Set(Object.keys(safe.nodes));
  for(const id of found){
    assertSafeId(id);
    if(!Object.prototype.hasOwnProperty.call(profile.sourceNodeMap,id))fail('UNMAPPED_SOURCE_NODE');
  }
  return safe;
}
/** Emits only a validated CSS subset; no URLs, JS, arbitrary selectors or style parsing. */
export function exportCss(document,profile,{selectorMode='source'}={}){
  const safe=validated(document,profile);
  if(!['source','runtime'].includes(selectorMode))fail('BAD_SELECTOR_MODE');
  const lines=['/* Visual Editor v1; app='+safe.target.appId+' route='+safe.target.routeId+' source='+safe.target.sourceRevision+'; review before applying */'];
  for(const id of Object.keys(safe.nodes).sort()){
    const byScope=safe.nodes[id],value=selectorMode==='source'?profile.sourceNodeMap[id]:id;
    const selector=attrSelector(selectorMode==='source'?'id':'data-ve-id',value);
    for(const bp of ['base','mobile']){
      if(!Object.prototype.hasOwnProperty.call(byScope,bp))continue;
      const declarations=Object.entries(byScope[bp]).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>'  '+k+': '+v+' !important;');
      if(!declarations.length)continue;
      if(bp==='base')lines.push(selector+' {',...declarations,'}');
      else{
        const condition=profile.breakpoints[bp];
        if(!condition)fail('UNSUPPORTED_BREAKPOINT');
        lines.push('@media '+condition+' {', '  '+selector+' {',...declarations.map(x=>'  '+x),'  }','}');
      }
    }
  }
  return lines.join('\n')+'\n';
}
function safePath(path){
  if(typeof path!=='string'||path.length>180||!/^([a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_.-]+\.css$/.test(path)||path.split('/').some(s=>s==='..'||s==='.'||s==='__proto__'))fail('UNSAFE_SOURCE_PATH');
  return path;
}
/** Review artifact only. No GitHub mutation, file write or source reverse-mapping claim. */
export function createSourceProposal(document,profile,{path='visual-editor-overrides.css'}={}){
  const css=exportCss(document,profile),safe=validated(document,profile),filename=safePath(path);
  return {
    schemaVersion:1,kind:'visual-editor-source-proposal',status:'REVIEW_REQUIRED',
    target:safe.target,expectedSourceRevision:safe.target.sourceRevision,
    files:[{path:filename,operation:'create-or-review',content:css}],
    diff:'--- /dev/null\n+++ b/'+filename+'\n@@ -0,0 +1,'+css.trimEnd().split('\n').length+' @@\n'+css.trimEnd().split('\n').map(x=>'+'+x).join('\n')+'\n',
    caveats:['Source ownership and actual revision must be verified by repository review.','This artifact contains styling only; structural model edits require an owner-authored layout manifest.']
  };
}
/** Safe static HTML snapshot only if caller supplies matching trusted original and source ID map. */
export function exportStaticHtml(document,profile,{source,expectedSource,expectedSourceRevision}={}){
  const css=exportCss(document,profile);
  if(typeof source!=='string'||!source||source!==expectedSource)fail('STALE_SOURCE');
  if(expectedSourceRevision!==profile.target.sourceRevision)fail('SOURCE_REVISION_CONFLICT');
  if(!/<html(?:\s|>)/i.test(source)||!(source.match(/<head(?:\s|>)/gi)||[]).length|| (source.match(/<\/head\s*>/gi)||[]).length!==1)fail('INVALID_STATIC_HTML');
  if(/<style\s+data-ve-export\s*=/.test(source))fail('EXPORT_ALREADY_PRESENT');
  const doc=validated(document,profile);
  for(const id of Object.keys(doc.nodes)){
    const domId=profile.sourceNodeMap[id];
    const matches=source.match(new RegExp('<[a-z][^<>]*\\bid=(["\\\'])'+escapeRegExp(domId)+'\\1[^<>]*>', 'gi'))||[];
    if(matches.length!==1)fail('SOURCE_IDENTITY_CONFLICT');
  }
  return source.replace(/<\/head\s*>/i,'<style data-ve-export="v1">\n'+css+'</style>\n</head>');
}

/** Review-only layout manifest: strips arbitrary application-owned payloads. */
export function exportModelLayout(model,profile){
  if(!profile||!['react-model','scene-graph'].includes(profile.ownership)||!profile.exports?.includes('layout-json'))fail('UNSUPPORTED_EXPORT');
  if(!model||typeof model!=='object'||!model.nodes||typeof model.nodes!=='object'||Array.isArray(model.nodes)||
    !Number.isSafeInteger(model.revision)||model.revision<0)fail('BAD_MODEL');
  const rootId=assertSafeId(model.rootId),ids=Object.keys(model.nodes);
  if(ids.length>1024||!ids.includes(rootId))fail('BAD_MODEL');
  const nodes=Object.create(null),found=new Set();
  for(const id of ids){
    assertSafeId(id);
    const node=model.nodes[id];
    if(!node||node.id!==id||typeof node.type!=='string'||!/^[a-zA-Z0-9_.:-]{1,128}$/.test(node.type)||!Array.isArray(node.children))fail('BAD_MODEL');
    if(node.parentId!==null)assertSafeId(node.parentId);
    if(id===rootId&&node.parentId!==null||id!==rootId&&node.parentId===null)fail('BAD_MODEL');
    if(new Set(node.children).size!==node.children.length)fail('DUPLICATE_CHILD');
    const children=node.children.map(child=>assertSafeId(child));
    nodes[id]={id,type:node.type,parentId:node.parentId,children};
  }
  const stack=[rootId];
  while(stack.length){
    const id=stack.pop(),node=nodes[id];
    if(!node||found.has(id))fail('CYCLE_OR_DISCONNECTED');
    found.add(id);
    for(const child of node.children){
      if(!nodes[child]||nodes[child].parentId!==id)fail('PARENT_MISMATCH');
      stack.push(child);
    }
  }
  if(found.size!==ids.length)fail('CYCLE_OR_DISCONNECTED');
  return {schemaVersion:1,kind:'visual-editor-layout-proposal',status:'REVIEW_REQUIRED',
    ownership:profile.ownership,target:profile.target,layoutRevision:model.revision,
    rootId,nodes,warning:'Layout metadata only. Owner must map to framework source and review before applying.'};
}
