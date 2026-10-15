import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {ModelLayoutSession} from './model-adapter.mjs';
const node=(id,parentId,type,children=[],caps=[],acceptTypes=[])=>({id,parentId,type,children,capabilities:caps,acceptTypes});
function baseline(){
 return {rootId:'root',revision:0,nodes:{
 root:node('root',null,'root',['panel','footer'],['structure.accept'],['panel','label']),
 panel:node('panel','root','panel',['title','subtitle'],['structure.move','structure.accept'],['label']),
 title:node('title','panel','label',[],['structure.move','structure.duplicate','structure.remove']),
 subtitle:node('subtitle','panel','label',[],['structure.move','structure.remove']),
 footer:node('footer','root','label',[],['structure.move','structure.remove'])
 }};
}
function treeElement(model,id){
 const n=model.nodes[id];
 return React.createElement('section',{'data-ve-id':id,key:id},n.children.map(child=>treeElement(model,child)));
}
function sceneOrder(model,id=model.rootId){
 return [id,...model.nodes[id].children.flatMap(c=>sceneOrder(model,c))];
}
test('M4 React renderer follows app-owned model order instead of moving mounted DOM',async()=>{
 let owner=baseline(),paintCount=0;
 const audio={voices:4}; // separate application domain state
 const session=new ModelLayoutSession({
   initialModel:owner,
   commitModel:async(next)=>{owner=next;paintCount++;}
 });
 const before=renderToStaticMarkup(treeElement(owner,'root'));
 assert.ok(before.indexOf('data-ve-id="title"')<before.indexOf('data-ve-id="subtitle"'));
 await session.transact({expectedRevision:0,operations:[{kind:'move',nodeId:'subtitle',parentId:'panel',beforeId:'title'}]});
 const after=renderToStaticMarkup(treeElement(owner,'root'));
 assert.ok(after.indexOf('data-ve-id="subtitle"')<after.indexOf('data-ve-id="title"'));
 assert.equal(paintCount,1);
 assert.deepEqual(audio,{voices:4});
 await session.undo();
 assert.equal(renderToStaticMarkup(treeElement(owner,'root')),before);
});
test('M4 scene projection uses same stable IDs without pretending pixels are nodes',async()=>{
 let owner=baseline();
 const session=new ModelLayoutSession({initialModel:owner,commitModel:next=>{owner=next;}});
 await session.transact({expectedRevision:0,operations:[{kind:'move',nodeId:'footer',parentId:'root',beforeId:'panel'}]});
 assert.deepEqual(sceneOrder(owner),['root','footer','panel','title','subtitle']);
 assert.equal(owner.nodes.footer.parentId,'root');
});
