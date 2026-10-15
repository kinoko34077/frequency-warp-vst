import test from 'node:test';
import assert from 'node:assert/strict';
import {newDocument,EditError} from './core.mjs';
import {resolvePageProfile} from './profiles.mjs';
import {exportCss,createSourceProposal,exportStaticHtml} from './export.mjs';
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
  rogue.nodes={...document.nodes,'__proto__':{base:{color:'#123456'}}};
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
