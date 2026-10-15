import {EditError,assertSafeId} from './core.mjs';
/** Model-owned tree editing pilot for React/scene renderers. Never mutates DOM or domain audio data. */
const fail=code=>{throw new EditError(code);};
const clone=x=>structuredClone(x);
const validKind=new Set(['move','duplicate','remove']);
function validateModel(model){
  if(!model||typeof model!=='object'||!model.nodes||typeof model.nodes!=='object')fail('BAD_MODEL');
  assertSafeId(model.rootId);
  const ids=Object.keys(model.nodes);
  if(ids.length>1024||!ids.includes(model.rootId))fail('BAD_MODEL');
  for(const id of ids){
    assertSafeId(id);const n=model.nodes[id];
    if(!n||n.id!==id||typeof n.type!=='string'||!Array.isArray(n.children))fail('BAD_MODEL');
    if(id===model.rootId&&n.parentId!==null)fail('BAD_MODEL');
    if(id!==model.rootId&&(!n.parentId||!model.nodes[n.parentId]))fail('BAD_MODEL');
    if(new Set(n.children).size!==n.children.length)fail('DUPLICATE_CHILD');
    for(const childId of n.children){
      if(!model.nodes[childId]||model.nodes[childId].parentId!==id)fail('PARENT_MISMATCH');
    }
  }
  const visited=new Set(),stack=[model.rootId];
  while(stack.length){
    const id=stack.pop();
    if(visited.has(id))fail('CYCLE_OR_DUPLICATE');
    visited.add(id);stack.push(...model.nodes[id].children);
  }
  if(visited.size!==ids.length)fail('DISCONNECTED_TREE');
  if(!Number.isSafeInteger(model.revision)||model.revision<0)fail('BAD_REVISION');
  return clone(model);
}
function capabilities(node){
  return Array.isArray(node?.capabilities)?node.capabilities:[];
}
function requireCapability(node,required){
  if(!capabilities(node).includes(required))fail('FORBIDDEN_CAPABILITY');
}
function move(next,op){
  const id=assertSafeId(op.nodeId),parentId=assertSafeId(op.parentId),node=next.nodes[id],parent=next.nodes[parentId];
  if(!node||!parent||id===next.rootId)fail('UNRESOLVED_NODE');
  requireCapability(node,'structure.move');requireCapability(parent,'structure.accept');
  if(!Array.isArray(parent.acceptTypes)||!parent.acceptTypes.includes(node.type))fail('INVALID_SLOT');
  let walk=parentId;while(walk!==null){if(walk===id)fail('CYCLE');walk=next.nodes[walk]?.parentId??null;}
  const before=op.beforeId===null||op.beforeId===undefined?null:assertSafeId(op.beforeId);
  if(before!==null&&(before===id||!parent.children.includes(before)))fail('INVALID_ANCHOR');
  const previous=next.nodes[node.parentId];previous.children=previous.children.filter(x=>x!==id);
  const pos=before===null?parent.children.length:parent.children.indexOf(before);
  parent.children.splice(pos,0,id);node.parentId=parentId;
}
function duplicate(next,op,factory){
  const id=assertSafeId(op.nodeId),newId=assertSafeId(op.newId),source=next.nodes[id];
  if(!source||Object.hasOwn(next.nodes,newId)||id===next.rootId)fail('INVALID_DUPLICATE');
  requireCapability(source,'structure.duplicate');
  if(source.children.length)fail('NONLEAF_DUPLICATE');
  const parent=next.nodes[source.parentId];requireCapability(parent,'structure.accept');
  if(!parent.acceptTypes?.includes(source.type))fail('INVALID_SLOT');
  if(typeof factory!=='function')fail('MISSING_FACTORY');
  const copy=factory(clone(source),newId);
  if(!copy||copy.id!==newId||copy.type!==source.type||copy.parentId!==source.parentId||!Array.isArray(copy.children)||copy.children.length)fail('INVALID_FACTORY');
  next.nodes[newId]=clone(copy);
  parent.children.splice(parent.children.indexOf(id)+1,0,newId);
}
function remove(next,op){
  const id=assertSafeId(op.nodeId),node=next.nodes[id];
  if(!node||id===next.rootId)fail('UNRESOLVED_NODE');
  requireCapability(node,'structure.remove');
  if(node.children.length)fail('NONLEAF_REMOVE');
  const parent=next.nodes[node.parentId];parent.children=parent.children.filter(x=>x!==id);
  delete next.nodes[id];
}
export function planModelTransaction(model,tx,{factory}={}){
  if(!tx||tx.expectedRevision!==model.revision)fail('REVISION_CONFLICT');
  if(!Array.isArray(tx.operations)||tx.operations.length<1||tx.operations.length>100)fail('BAD_TRANSACTION');
  const next=validateModel(model);
  for(const op of tx.operations){
    if(!op||!validKind.has(op.kind))fail('UNSUPPORTED_OPERATION');
    if(op.kind==='move')move(next,op);
    if(op.kind==='duplicate')duplicate(next,op,factory);
    if(op.kind==='remove')remove(next,op);
  }
  next.revision++;return validateModel(next);
}
export class ModelLayoutSession{
  #model;#commit;#factory;#limit;#undo=[];#redo=[];#busy=false;
  constructor({initialModel,commitModel,factory,historyLimit=40}){
    if(typeof commitModel!=='function')fail('BAD_ADAPTER');
    this.#model=validateModel(initialModel);this.#commit=commitModel;this.#factory=factory;
    if(!Number.isInteger(historyLimit)||historyLimit<1||historyLimit>200)fail('BAD_HISTORY_LIMIT');
    this.#limit=historyLimit;
  }
  get model(){return clone(this.#model);}
  get busy(){return this.#busy;}
  get canUndo(){return this.#undo.length>0;}
  get canRedo(){return this.#redo.length>0;}
  async #commitChange(next,withHistory){
    if(this.#busy)fail('BUSY');this.#busy=true;
    const before=this.#model;
    try{
      try{await this.#commit(clone(next),clone(before));}
      catch{try{await this.#commit(clone(before),clone(next));}catch{fail('ROLLBACK_FAILED');}fail('MODEL_COMMIT_FAILED');}
      this.#model=next;
      if(withHistory){this.#undo.push(clone(before));if(this.#undo.length>this.#limit)this.#undo.shift();this.#redo=[];}
      return this.model;
    }finally{this.#busy=false;}
  }
  async transact(tx){if(this.#busy)fail('BUSY');return this.#commitChange(planModelTransaction(this.#model,tx,{factory:this.#factory}),true);}
  async undo(){
    if(this.#busy)fail('BUSY');if(!this.canUndo)fail('NO_UNDO');
    const prev=clone(this.#model),next=clone(this.#undo.at(-1));
    await this.#commitChange(next,false);this.#undo.pop();this.#redo.push(prev);return this.model;
  }
  async redo(){
    if(this.#busy)fail('BUSY');if(!this.canRedo)fail('NO_REDO');
    const prev=clone(this.#model),next=clone(this.#redo.at(-1));
    await this.#commitChange(next,false);this.#redo.pop();this.#undo.push(prev);return this.model;
  }
}
