import test from 'node:test';
import assert from 'node:assert/strict';
import {VisualEditSession,EditError,newDocument,planTransaction,validateDocument} from './core.mjs';
import {createDomStyleAdapter} from './dom-adapter.mjs';
const target={appId:'fw',routeId:'home',templateId:'main',sourceRevision:'r1'};
function fixture(){
  const rendered=[],data=new Map();let failRender=false;
  return {
    rendered,data,failRender:()=>{failRender=true},
    adapter:{
      describe:id=>id==='header'?{identity:id,capabilities:['style.safe']}:null,
      async applyState(doc){if(failRender){failRender=false;throw Error('paint failed');}rendered.push(doc);}
    },
    storage:{setItem(k,v){data.set(k,v);},getItem:k=>data.get(k)||null}
  };
}
const edit=(expectedRevision,value)=>({expectedRevision,operations:[{kind:'setStyle',nodeId:'header',breakpoint:'base',property:'width',value}]});
test('M1 revision and immutable document',async()=>{
  const m=fixture(),s=new VisualEditSession({target,adapter:m.adapter});
  await s.transact(edit(0,'80%'));assert.equal(s.document.nodes.header.base.width,'80%');
  assert.throws(()=>planTransaction(s.document,edit(0,'50%'),m.adapter),{code:'REVISION_CONFLICT'});
  assert.equal(s.document.designRevision,1);
});
test('M1 rejects unsafe and unsupported edits atomically',async()=>{
  const m=fixture(),s=new VisualEditSession({target,adapter:m.adapter});
  const invalid=[
    {kind:'setStyle',nodeId:'missing',property:'width',value:'5px'},
    {kind:'setStyle',nodeId:'header',property:'background-image',value:'url(x)'},
    {kind:'setStyle',nodeId:'header',property:'width',value:'calc(9px)'},
    {kind:'moveNode',nodeId:'header'},
    {kind:'setStyle',nodeId:'header',property:'order',value:'1'}
  ];
  for(const op of invalid)await assert.rejects(s.transact({expectedRevision:0,operations:[{...op,breakpoint:'base'}]}),EditError);
  assert.equal(s.document.designRevision,0);
});
test('M2 history and redo branch reset',async()=>{
  const s=new VisualEditSession({target,adapter:fixture().adapter,historyLimit:2});
  await s.transact(edit(0,'40px'));await s.transact(edit(1,'50px'));
  await s.undo();assert.equal(s.document.nodes.header.base.width,'40px');
  await s.redo();assert.equal(s.document.nodes.header.base.width,'50px');
  await s.undo();await s.transact(edit(1,'60px'));assert.equal(s.canRedo,false);
});
test('M2 save restore isolates app/build and resets transient history',async()=>{
  const m=fixture();let s=new VisualEditSession({target,adapter:m.adapter,storage:m.storage,storageKey:'key'});
  await s.transact(edit(0,'40px'));
  s=VisualEditSession.restore({target,adapter:m.adapter,storage:m.storage,storageKey:'key'});
  assert.equal(s.document.nodes.header.base.width,'40px');assert.equal(s.canUndo,false);
  assert.throws(()=>VisualEditSession.restore({target:{...target,sourceRevision:'r2'},adapter:m.adapter,storage:m.storage,storageKey:'key'}),{code:'TARGET_MISMATCH'});
});
test('M2 rejected compound edit retains state and rollback after render error',async()=>{
  const m=fixture(),s=new VisualEditSession({target,adapter:m.adapter});
  await assert.rejects(s.transact({expectedRevision:0,operations:[edit(0,'30px').operations[0],{kind:'setStyle',nodeId:'no',breakpoint:'base',property:'width',value:'5px'}]}),EditError);
  m.failRender();await assert.rejects(s.transact(edit(0,'60px')),{code:'COMMIT_FAILED'});
  assert.equal(s.document.designRevision,0);assert.equal(m.rendered.at(-1).designRevision,0);
});
test('M2 persistence failure rolls back applied document',async()=>{
  const m=fixture(),storage={setItem(){throw Error('storage quota');},getItem(){return null}};
  const s=new VisualEditSession({target,adapter:m.adapter,storage,storageKey:'key'});
  await assert.rejects(s.transact(edit(0,'40px')),{code:'COMMIT_FAILED'});
  assert.equal(s.document.designRevision,0);assert.equal(m.rendered.at(-1).designRevision,0);
});
test('M2 unknown schema, prototype keys and selector injection are rejected',()=>{
  const m=fixture();
  for(const input of ['{','{"schemaVersion":2}','{"schemaVersion":1}']){
    m.data.set('key',input);assert.throws(()=>VisualEditSession.restore({target,adapter:m.adapter,storage:m.storage,storageKey:'key'}),EditError);
  }
  const d=newDocument(target);d.nodes=JSON.parse('{"__proto__":{"base":{"width":"1px"}}}');
  assert.throws(()=>validateDocument(d,target),{code:'BAD_ID'});
});
test('M2 serializes async commits / no competing gestures',async()=>{
  let release;const gate=new Promise(r=>{release=r});
  const adapter={describe:id=>({identity:id,capabilities:['style.safe']}),applyState:()=>gate};
  const s=new VisualEditSession({target,adapter}),pending=s.transact(edit(0,'10px'));
  await assert.rejects(s.transact(edit(0,'20px')),{code:'BUSY'});
  release();await pending;
});
test('M3 DOM adapter uses explicit IDs without modifying DOM structure',async()=>{
  const node={getAttribute:k=>k==='data-ve-id'?'title':null,parentElement:null};
  const root={getAttribute:()=>null,querySelectorAll:()=>[node]};
  const style={textContent:''};
  const adapter=createDomStyleAdapter({root,styleElement:style,target,allowedIds:['title']});
  const s=new VisualEditSession({target,adapter});
  await s.transact({expectedRevision:0,operations:[{kind:'setStyle',nodeId:'title',breakpoint:'base',property:'color',value:'#AABBCC'}]});
  assert.match(style.textContent,/data-ve-id="title"/);
  assert.match(style.textContent,/#aabbcc/);
  assert.throws(()=>adapter.resolve('other'),{code:'FORBIDDEN_NODE'});
});
