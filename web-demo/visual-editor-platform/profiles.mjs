import {EditError,assertSafeId,validateTarget,SAFE_BREAKPOINTS} from './core.mjs';
const fail=code=>{throw new EditError(code);};
const own=(v,k)=>Object.prototype.hasOwnProperty.call(v,k);
const plain=v=>!!v&&typeof v==='object'&&!Array.isArray(v)&&Object.getPrototypeOf(v)===Object.prototype;
export const ENGINE_PROFILES=Object.freeze({
  'static-dom':Object.freeze({adapter:'dom-style',operations:['style.safe','order.visual'],exports:['css','html','project-source']}),
  'react-model':Object.freeze({adapter:'owner-model',operations:['structure.move','structure.duplicate','structure.remove'],exports:['layout-json']}),
  'scene-graph':Object.freeze({adapter:'owner-scene',operations:['structure.move','structure.duplicate','structure.remove'],exports:['layout-json']})
});
function validateMap(source){
  if(!plain(source)||Object.keys(source).length>2048)fail('BAD_SOURCE_MAP');
  const out=Object.create(null),used=new Set();
  for(const [id,domId] of Object.entries(source)){
    assertSafeId(id);assertSafeId(domId);
    if(used.has(domId))fail('DUPLICATE_SOURCE_TARGET');
    used.add(domId);out[id]=domId;
  }
  return out;
}
function validateBreakpoints(value){
  if(!plain(value)||Object.keys(value).some(k=>!SAFE_BREAKPOINTS.includes(k)||k==='base'))fail('BAD_BREAKPOINT');
  const result={};
  for(const [name,query] of Object.entries(value)){
    if(typeof query!=='string'||!/^\(max-width: ([2-9]\d{2}|[1-3]\d{3}|4000)px\)$/.test(query))fail('BAD_BREAKPOINT');
    result[name]=query;
  }
  return result;
}
/** Deterministic, capability-denying strategy selection. Hosting and URL are not render ownership. */
export function resolvePageProfile({target,ownership,sourceNodeMap={},breakpoints=ownership==='static-dom'?{mobile:'(max-width: 800px)'}:{},requiredOperations=[]}){
  const safeTarget=validateTarget(target);
  if(!own(ENGINE_PROFILES,ownership))fail('UNSUPPORTED_OWNERSHIP');
  const engine=ENGINE_PROFILES[ownership];
  if(!Array.isArray(requiredOperations)||new Set(requiredOperations).size!==requiredOperations.length||requiredOperations.some(x=>typeof x!=='string'||!engine.operations.includes(x)))fail('UNSUPPORTED_CAPABILITY');
  const mapping=validateMap(sourceNodeMap),queries=validateBreakpoints(breakpoints);
  if(ownership!=='static-dom'&&(Object.keys(mapping).length||Object.keys(queries).length))fail('INCOMPATIBLE_PROFILE');
  return Object.freeze({
    target:safeTarget,ownership,adapter:engine.adapter,
    operations:Object.freeze([...engine.operations]),
    exports:Object.freeze([...engine.exports]),
    sourceNodeMap:Object.freeze(mapping),breakpoints:Object.freeze(queries)
  });
}
