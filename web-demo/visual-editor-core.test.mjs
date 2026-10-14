import test from 'node:test';
import assert from 'node:assert/strict';
import {sanitizeRule,normalizeChanges,cssForChanges,moveSibling} from './visual-editor-core.mjs';
test('property whitelist and safe CSS values',()=>{
  assert.equal(sanitizeRule('width','50%'),'50%');
  assert.equal(sanitizeRule('padding','16px'),'16px');
  assert.equal(sanitizeRule('color','#ABCD12'),'#abcd12');
  assert.equal(sanitizeRule('order','-1'),'-1');
  for(const bad of ['1px;color:red','url(javascript:alert(1))','-3px','33333px','calc(2px + 3px)'])assert.equal(sanitizeRule('gap',bad),null);
  assert.equal(sanitizeRule('position','fixed'),null);
  assert.equal(sanitizeRule('order','0.5'),null);
});
test('normalization ignores selectors and properties with injection text',()=>{
  const cleaned=normalizeChanges({version:1,global:{'#player-title':{'font-size':'20px',evil:'yes'},'body {display:none}':{padding:'5px'}},mobile:{'#wave':{width:'90%'}}});
  assert.deepEqual(cleaned.global,{'#player-title':{'font-size':'20px'}});
  assert.match(cssForChanges(cleaned),/@media\(max-width:800px\)/);
  assert.match(cssForChanges(cleaned),/width: 90% !important/);
  assert.doesNotMatch(cssForChanges(cleaned),/evil|body \{display:none\}/);
});
test('visual reorder returns new list and preserves original order',()=>{
  const original=['#a','#b','#c'];
  assert.deepEqual(moveSibling(original,'#b',-1),['#b','#a','#c']);
  assert.deepEqual(original,['#a','#b','#c']);
  assert.equal(moveSibling(original,'#a',-1),null);
});