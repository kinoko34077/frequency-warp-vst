import {test} from "node:test";
import assert from "node:assert/strict";
import {auditUnitConsumer,auditWebModuleTree} from "./capability-reuse-check.mjs";

test("current production numeric unit modules use an existing canonical binding",()=>{
  assert.deepEqual(auditWebModuleTree(),[]);
});
test("reject a new copied Hz/note/% widget without canonical binding",()=>{
  const duplicated='<div class="unit-switch"></div> function fromText(){ return parseView(input.value, unit); }';
  assert.match(auditUnitConsumer("new-controls.mjs",duplicated).join("\n"),/must consume/);
});
test("reject parallel F/H state even when an agent superficially imports the binding",()=>{
  const duplicated='createParameterBinding({}); const units={F:"hz",H:"hz"}; const state={F:350,H:87.5};';
  const errors=auditUnitConsumer("virtual-root-workbench.mjs",duplicated).join("\n");
  assert.match(errors,/parallel F\/H display-unit/);
  assert.match(errors,/parallel F\/H canonical/);
});
test("allow a truly different specialized rail without duplicating unit semantics",()=>{
  assert.deepEqual(auditUnitConsumer("unique-rail.mjs",'export const toRail = hz => Math.round(hz);'),[]);
});
test("allow a UI that adapts a shared canonical binding",()=>{
  const using='<div class="unit-switch"></div> const control = createParameterBinding(descriptor); createParameterUnitSwitch(options); function fromText(v){return control.setView(v);}';
  assert.deepEqual(auditUnitConsumer("new-controls.mjs",using),[]);
});
test("reject a copied unit icon UI even if it imports the value binding",()=>{
  const duplicated='<div class="unit-switch"><button data-vr-unit="hz">Hz</button></div> const binding = createParameterBinding(descriptor); function fromText(){return binding.value;}';
  assert.match(auditUnitConsumer("bespoke-units.mjs",duplicated).join("\\n"),/icon UI must reuse/);
});

test("reject duplicated percent-input focus/commit logic or absent shared owner in Web app",()=>{
  const repeated=`const commitWetTyped=()=>{ wetBinding.setView(value,{unit:"percent"}); };
  mountPercentParameterField({field,binding,refresh});`;
  assert.match(auditUnitConsumer("app.mjs",repeated).join("\n"),/copied typed-percent/);
  const missing=`const wetBinding={value:.5}; const wetField={};`;
  assert.match(auditUnitConsumer("app.mjs",missing).join("\n"),/must reuse mountPercentParameterField/);
});
