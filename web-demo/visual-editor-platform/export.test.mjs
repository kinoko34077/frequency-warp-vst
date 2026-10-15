import test from 'node:test';
import assert from 'node:assert/strict';
import {newDocument,EditError} from './core.mjs';
import {resolvePageProfile} from './profiles.mjs';
import {exportCss,createSourceProposal,exportStaticHtml,exportModelLayout} from './export.mjs';
const target={appId:'fw',routeId:'main',templateId:'web-ui',sourceRevision:'layout-r1'};
const profile=resolvePageProfile({target,ownership:'static-dom',
  sourceNodeMap:{'header.title':'headerTitle','footer.note':'footerNote'},requiredOperations:['style.safe']});
const document=newDocument(target);
document.nodes={'header.title':{base:{color:'#AABBCC'},mobile:{'font-size':'20px'}},'footer.note':{base:{width:'75%'}}};
test('M5 chooses safe shared adapter from explicit page ownership',()=>{
  assert.equal(profile.adapter,'dom-style');
  const react=resolvePageProfile({target,ownership:'react-model',breakpoints:{},requiredOperations:['structure.move']});
  assert.equal(react.adapter,'owner-model');
  const scene=resolvePageProfile({target,ownership:'scene-graph',breakpoints:{},requiredOperations:['structure.move']});
  assert.equal(scene.adapter,'owner-scene');
  assert.throws(()=>resolvePageProfile({target,ownership:'react-model',breakpoints:{},requiredOperations:['style.safe']}),{code:'UNSUPPORTED_CAPABILITY'});
  assert.throws(()=>resolvePageProfile({target,ownership:'magic',breakpoints:{}}),{code:'UNSUPPORTED_OWNERSHIP'});
});
test('M5 export returns stable scoped CSS without injection or unapproved targets',()=>{
  const css=exportCss(document,profile);
  assert.match(css,/\[id="headerTitle"\]/);
  assert.match(css,/max-width: 800px/);
  assert.match(css,/#aabbcc/);
  assert.equal(css,exportCss(document,profile));
  assert.match(exportCss(document,profile,{selectorMode:'runtime'}),/data-ve-id="header.title"/);
  const rogue=structuredClone(document);rogue.nodes['missing']={base:{color:'#112233'}};
  assert.throws(()=>exportCss(rogue,profile),{code:'UNMAPPED_SOURCE_NODE'});
  rogue.nodes=structuredClone(document.nodes);
  rogue.nodes['header.title'].base.color='red; background:url(https://evil)';
  assert.throws(()=>exportCss(rogue,profile),EditError);
});
test('M5 generates reviewable local proposal but does not mutate sources',()=>{
  const proposal=createSourceProposal(document,profile,{path:'styles/layout-editor.css'});
  assert.equal(proposal.status,'REVIEW_REQUIRED');
  assert.equal(proposal.expectedSourceRevision,'layout-r1');
  assert.match(proposal.diff,/\+\+\+ b\/styles\/layout-editor.css/);
  assert.equal(proposal.files.length,1);
  assert.throws(()=>createSourceProposal(document,profile,{path:'../secret.css'}),{code:'UNSAFE_SOURCE_PATH'});
});
test('M5 static HTML export requires exact source, unique identity and matching revision',()=>{
  const html='<html><head><title>x</title></head><body><h1 id="headerTitle">T</h1><footer id=\'footerNote\'>F</footer></body></html>';
  const result=exportStaticHtml(document,profile,{source:html,expectedSource:html,expectedSourceRevision:'layout-r1'});
  assert.match(result,/<style data-ve-export="v1">/);
  assert.match(result,/id="footerNote"/);
  assert.equal(html.includes('data-ve-export'),false);
  assert.throws(()=>exportStaticHtml(document,profile,{source:html,expectedSource:html+'!',expectedSourceRevision:'layout-r1'}),{code:'STALE_SOURCE'});
  assert.throws(()=>exportStaticHtml(document,profile,{source:html,expectedSource:html,expectedSourceRevision:'stale'}),{code:'SOURCE_REVISION_CONFLICT'});
  const dup=html.replace('</body>','<div id="headerTitle"></div></body>');
  assert.throws(()=>exportStaticHtml(document,profile,{source:dup,expectedSource:dup,expectedSourceRevision:'layout-r1'}),{code:'SOURCE_IDENTITY_CONFLICT'});
  assert.throws(()=>exportStaticHtml(document,profile,{source:result,expectedSource:result,expectedSourceRevision:'layout-r1'}),{code:'EXPORT_ALREADY_PRESENT'});
});
test('M5 source/export surfaces reject schema, target and profile violations',()=>{
  const old={...document,target:{...target,sourceRevision:'different'}};
  assert.throws(()=>exportCss(old,profile),{code:'TARGET_MISMATCH'});
  const model=resolvePageProfile({target,ownership:'react-model',breakpoints:{}});
  assert.throws(()=>exportCss(document,model),{code:'UNSUPPORTED_EXPORT'});
  assert.throws(()=>resolvePageProfile({target,ownership:'static-dom',sourceNodeMap:{'header.title':'a','footer.note':'a'}}),{code:'DUPLICATE_SOURCE_TARGET'});
});

test('M5 React/scene export contains only layout metadata and rejects broken graph',()=>{
 const selected=resolvePageProfile({target,ownership:'react-model'});
 const model={rootId:'root',revision:2,nodes:{
  root:{id:'root',type:'panel',parentId:null,children:['card'],secret:'NEVER_EXPORT'},
  card:{id:'card',type:'text',parentId:'root',children:[],domainPayload:'NEVER_EXPORT'}
 }};
 const out=exportModelLayout(model,selected);
 assert.equal(out.status,'REVIEW_REQUIRED');
 assert.equal(out.layoutRevision,2);
 assert.equal(JSON.stringify(out).includes('NEVER_EXPORT'),false);
 assert.deepEqual(out.nodes.root.children,['card']);
 const broken=structuredClone(model);broken.nodes.card.parentId='nonexistent';
 assert.throws(()=>exportModelLayout(broken,selected),{code:'PARENT_MISMATCH'});
 assert.throws(()=>exportModelLayout(model,profile),{code:'UNSUPPORTED_EXPORT'});
});

test('static HTML ID mapping rejects data-id, quoted attribute text and inert script/comment matches',()=>{
  const check=source=>exportStaticHtml(document,profile,{source,expectedSource:source,expectedSourceRevision:'layout-r1'});
  const frame=(head,content)=>'<html><head>'+head+'</head><body>'+content+'<footer id="footerNote"></footer></body></html>';
  const fakeDataId=frame('','<h1 data-id="headerTitle">Fake</h1>');
  assert.throws(()=>check(fakeDataId),{code:'SOURCE_IDENTITY_CONFLICT'});
  const quotedLabel=frame('','<h1 aria-label=\'description id="headerTitle"\'>Fake</h1>');
  assert.throws(()=>check(quotedLabel),{code:'SOURCE_IDENTITY_CONFLICT'});
  const script=frame('<script>const fake = \'<h1 id="headerTitle">not a node</h1>\';</script>','<h1>no id</h1>');
  assert.throws(()=>check(script),{code:'SOURCE_IDENTITY_CONFLICT'});
  const comment=frame('<!-- <h1 id="headerTitle"></h1> -->','<h1>no id</h1>');
  assert.throws(()=>check(comment),{code:'SOURCE_IDENTITY_CONFLICT'});
  const valid=frame('','<h1 aria-label=\'description id="headerTitle"\' id = "headerTitle">Real</h1>');
  assert.match(check(valid),/data-ve-export="v1"/);
  const duplicateInOneTag=frame('','<h1 id="headerTitle" id=\'headerTitle\'>Dup</h1>');
  assert.throws(()=>check(duplicateInOneTag),{code:'SOURCE_IDENTITY_CONFLICT'});
});
