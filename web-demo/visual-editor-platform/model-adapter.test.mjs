import test from 'node:test';
import assert from 'node:assert/strict';
import {ModelLayoutSession,planModelTransaction} from './model-adapter.mjs';
const initial=()=>{
  const leaf=(id,parentId,type='label',caps=['structure.move','structure.duplicate','structure.remove'])=>({id,parentId,type,children:[],capabilities:caps});
  return {rootId:'root',revision:0,nodes:{
    root:{id:'root',parentId:null,type:'root',children:['group','caption'],capabilities:['structure.accept'],acceptTypes:['group','label']},
    group:{id:'group',parentId:'root',type:'group',children:['note','setting'],capabilities:['structure.accept','structure.move'],acceptTypes:['label']},
    note:leaf('note','group'),
    setting:leaf('setting','group','control',[]),
    caption:leaf('caption','root')
  }};
};
const tx=(rev,...operations)=>({expectedRevision:rev,operations});
const factory=(n,id)=>({...n,id,children:[]});
test('M4 React/scene-owned move is model-only and preserves protected app state',async()=>{
  let model=initial();const audio={pressed:['C4'],voices:3};
  const s=new ModelLayoutSession({initialModel:model,commitModel:next=>{model=next;},factory});
  await s.transact(tx(0,{kind:'move',nodeId:'note',parentId:'root',beforeId:'caption'}));
  assert.deepEqual(model.nodes.root.children,['group','note','caption']);
  assert.deepEqual(model.nodes.group.children,['setting']);
  assert.deepEqual(audio,{pressed:['C4'],voices:3});
  await s.undo();assert.deepEqual(model.nodes.group.children,['note','setting']);
  await s.redo();assert.deepEqual(model.nodes.root.children,['group','note','caption']);
});
test('M4 factory-only leaf duplication, deletion and undo',async()=>{
  let owner=initial(),s=new ModelLayoutSession({initialModel:owner,commitModel:next=>{owner=next;},factory});
  await s.transact(tx(0,{kind:'duplicate',nodeId:'note',newId:'note2'}));
  assert.deepEqual(owner.nodes.group.children,['note','note2','setting']);
  assert.equal(owner.nodes.note2.id,'note2');
  await s.transact(tx(1,{kind:'remove',nodeId:'note2'}));
  assert.equal(owner.nodes.note2,undefined);
  await s.undo();assert.equal(owner.nodes.note2.id,'note2');
});
test('M4 permission boundaries, cycles, anchor and owner factories fail closed',()=>{
  const base=initial();
  for(const op of [
    {kind:'move',nodeId:'setting',parentId:'root'},
    {kind:'move',nodeId:'group',parentId:'group'},
    {kind:'move',nodeId:'note',parentId:'root',beforeId:'setting'},
    {kind:'remove',nodeId:'group'},
    {kind:'duplicate',nodeId:'note',newId:'note'}
  ])assert.throws(()=>planModelTransaction(base,tx(0,op),{factory}));
  assert.equal(base.revision,0);
});
test('M4 invalid model projection and synchronous commit failure roll back owner state',async()=>{
  let owner=initial(),fail=true;
  const s=new ModelLayoutSession({initialModel:owner,commitModel:next=>{
    if(fail){fail=false;throw Error('render error');}owner=next;
  },factory});
  await assert.rejects(s.transact(tx(0,{kind:'move',nodeId:'note',parentId:'root'})),{code:'MODEL_COMMIT_FAILED'});
  assert.equal(s.model.revision,0);
  assert.deepEqual(owner.nodes.root.children,['group','caption']);
});
test('M4 renderer cannot clone domain-bound control without capability',()=>{
  assert.throws(()=>planModelTransaction(initial(),tx(0,{kind:'duplicate',nodeId:'setting',newId:'setting-copy'}),{factory}),{code:'FORBIDDEN_CAPABILITY'});
});
