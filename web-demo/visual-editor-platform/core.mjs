/** Shared visual editor contract v1. Only the edit document is owned by this module. */
export const SCHEMA_VERSION=1;
export const SAFE_PROPERTIES=Object.freeze(['width','height','padding','margin','gap','border-radius','font-size','background-color','color','order']);
export const SAFE_BREAKPOINTS=Object.freeze(['base','mobile']);
const safeIds=/^[a-zA-Z0-9_.:-]{1,128}$/;
const forbidden=new Set(['__proto__','prototype','constructor']);
export class EditError extends Error{constructor(code){super(code);this.name='EditError';this.code=code;}}
function fail(code){throw new EditError(code);}
function plain(o){return !!o&&typeof o==='object'&&!Array.isArray(o)&&Object.getPrototypeOf(o)===Object.prototype;}
const clone=value=>structuredClone(value);
export function assertSafeId(id){if(typeof id!=='string'||!safeIds.test(id)||forbidden.has(id))fail('BAD_ID');return id;}
export function sanitizeStyle(prop,value){
  if(!SAFE_PROPERTIES.includes(prop))fail('BAD_PROPERTY');
  if(typeof value!=='string'||value.length>64)fail('BAD_VALUE');
  const v=value.trim();
  if(prop==='order'){
    if(!/^-?\d{1,3}$/.test(v)||Math.abs(Number(v))>999)fail('BAD_VALUE');
    return String(Number(v));
  }
  if(prop==='color'||prop==='background-color'){
    if(!/^#[a-f0-9]{6}$/i.test(v))fail('BAD_VALUE');
    return v.toLowerCase();
  }
  if(!/^\d+(?:\.\d{1,2})?(?:px|%)$/.test(v)||parseFloat(v)>3000)fail('BAD_VALUE');
  return v;
}
export function validateTarget(target){
  if(!plain(target))fail('BAD_TARGET');
  return Object.fromEntries(['appId','routeId','templateId','sourceRevision'].map(k=>[k,assertSafeId(target[k])]));
}
export function newDocument(target){return {schemaVersion:1,target:validateTarget(target),designRevision:0,nodes:{}};}
export function validateDocument(raw,expectedTarget){
  if(!plain(raw)||raw.schemaVersion!==1)fail('INCOMPATIBLE_SCHEMA');
  const target=validateTarget(raw.target),expected=validateTarget(expectedTarget);
  if(Object.keys(expected).some(k=>target[k]!==expected[k]))fail('TARGET_MISMATCH');
  if(!Number.isSafeInteger(raw.designRevision)||raw.designRevision<0)fail('BAD_REVISION');
  if(!plain(raw.nodes)||Object.keys(raw.nodes).length>2048)fail('BAD_NODES');
  const nodes={};
  for(const [id,scopes] of Object.entries(raw.nodes)){
    assertSafeId(id);if(!plain(scopes))fail('BAD_NODES');
    nodes[id]={};
    for(const [bp,props] of Object.entries(scopes)){
      if(!SAFE_BREAKPOINTS.includes(bp)||!plain(props))fail('BAD_NODES');
      nodes[id][bp]={};
      for(const [key,value] of Object.entries(props))nodes[id][bp][key]=sanitizeStyle(key,value);
    }
  }
  return {schemaVersion:1,target,designRevision:raw.designRevision,nodes};
}
function normalizeOperation(op){
  if(!plain(op)||!['setStyle','removeStyle'].includes(op.kind))fail('UNSUPPORTED_OPERATION');
  const nodeId=assertSafeId(op.nodeId),breakpoint=op.breakpoint,property=op.property;
  if(!SAFE_BREAKPOINTS.includes(breakpoint))fail('BAD_BREAKPOINT');
  if(!SAFE_PROPERTIES.includes(property))fail('BAD_PROPERTY');
  return {kind:op.kind,nodeId,breakpoint,property,...(op.kind==='setStyle'?{value:sanitizeStyle(property,op.value)}:{})};
}
export function planTransaction(doc,transaction,adapter){
  if(!plain(transaction)||!Array.isArray(transaction.operations)||transaction.operations.length<1||transaction.operations.length>100)fail('BAD_TRANSACTION');
  if(transaction.expectedRevision!==doc.designRevision)fail('REVISION_CONFLICT');
  const next=clone(doc);
  for(const opRaw of transaction.operations){
    const op=normalizeOperation(opRaw);
    const descriptor=adapter.describe(op.nodeId);
    if(!descriptor||descriptor.identity!==op.nodeId)fail('UNRESOLVED_NODE');
    if(!descriptor.capabilities?.includes('style.safe'))fail('FORBIDDEN_CAPABILITY');
    if(op.property==='order'&&!descriptor.capabilities.includes('order.visual'))fail('FORBIDDEN_CAPABILITY');
    if(descriptor.properties&&!descriptor.properties.includes(op.property))fail('FORBIDDEN_PROPERTY');
    const scopes=next.nodes[op.nodeId]??(next.nodes[op.nodeId]={});
    const styles=scopes[op.breakpoint]??(scopes[op.breakpoint]={});
    if(op.kind==='setStyle')styles[op.property]=op.value;
    else delete styles[op.property];
    if(!Object.keys(styles).length)delete scopes[op.breakpoint];
    if(!Object.keys(scopes).length)delete next.nodes[op.nodeId];
  }
  next.designRevision++;
  return next;
}
export class VisualEditSession{
  #doc;#adapter;#storage;#key;#undo=[];#redo=[];#busy=false;#limit;
  constructor({target,adapter,storage=null,storageKey=null,historyLimit=40,initial=null}){
    if(!adapter||typeof adapter.describe!=='function'||typeof adapter.applyState!=='function')fail('BAD_ADAPTER');
    if(!Number.isInteger(historyLimit)||historyLimit<1||historyLimit>200)fail('BAD_HISTORY_LIMIT');
    if(storage&&(!storageKey||typeof storage.setItem!=='function'))fail('BAD_STORAGE');
    this.#doc=initial?validateDocument(initial,target):newDocument(target);
    this.#adapter=adapter;this.#storage=storage;this.#key=storageKey;this.#limit=historyLimit;
  }
  get document(){return clone(this.#doc);}
  get canUndo(){return !!this.#undo.length;}
  get canRedo(){return !!this.#redo.length;}
  get busy(){return this.#busy;}
  async #commit(next,addHistory,clearRedo){
    if(this.#busy)fail('BUSY');this.#busy=true;
    const previous=this.#doc;
    try{
      try{
        await this.#adapter.applyState(clone(next),clone(previous));
        if(this.#storage)this.#storage.setItem(this.#key,JSON.stringify(next));
      }catch(e){
        try{await this.#adapter.applyState(clone(previous),clone(next));}
        catch{fail('ROLLBACK_FAILED');}
        if(e instanceof EditError)throw e;
        fail(this.#storage&&e?.name==='QuotaExceededError'?'PERSIST_FAILED':'COMMIT_FAILED');
      }
      this.#doc=next;
      if(addHistory){this.#undo.push(clone(previous));if(this.#undo.length>this.#limit)this.#undo.shift();}
      if(clearRedo)this.#redo=[];
      return this.document;
    }finally{this.#busy=false;}
  }
  async transact(tx){if(this.#busy)fail('BUSY');return this.#commit(planTransaction(this.#doc,tx,this.#adapter),true,true);}
  async undo(){
    if(this.#busy)fail('BUSY');if(!this.canUndo)fail('NO_UNDO');
    const next=clone(this.#undo.at(-1)),previous=clone(this.#doc);
    await this.#commit(next,false,false);this.#undo.pop();this.#redo.push(previous);return this.document;
  }
  async redo(){
    if(this.#busy)fail('BUSY');if(!this.canRedo)fail('NO_REDO');
    const next=clone(this.#redo.at(-1)),previous=clone(this.#doc);
    await this.#commit(next,false,false);this.#redo.pop();this.#undo.push(previous);return this.document;
  }
  async refresh(){if(this.#busy)fail('BUSY');await this.#adapter.applyState(this.document,null);}
  static restore({target,adapter,storage,storageKey,historyLimit=40}){
    const raw=storage?.getItem(storageKey);
    if(!raw)return new VisualEditSession({target,adapter,storage,storageKey,historyLimit});
    let parsed;try{parsed=JSON.parse(raw)}catch{fail('CORRUPT_DOCUMENT');}
    return new VisualEditSession({target,adapter,storage,storageKey,historyLimit,initial:parsed});
  }
}
