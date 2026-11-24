import {test} from "node:test";
import assert from "node:assert/strict";
import {auditUnitConsumer,auditWebModuleTree,auditStaticMarkup,auditSharedControlStyles} from "./capability-reuse-check.mjs";
import {mkdtempSync,writeFileSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";

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
  assert.match(auditUnitConsumer("bespoke-units.mjs",duplicated).join("\n"),/icon UI must reuse/);
});

test("reject duplicated percent-input focus/commit logic or absent shared owner in Web app",()=>{
  const repeated=`const commitWetTyped=()=>{ wetBinding.setView(value,{unit:"percent"}); };
  mountPercentParameterField({field,binding,refresh});`;
  assert.match(auditUnitConsumer("app.mjs",repeated).join("\n"),/copied typed-percent/);
  const missing=`const wetBinding={value:.5}; const wetField={};`;
  assert.match(auditUnitConsumer("app.mjs",missing).join("\n"),/must reuse mountPercentParameterField/);
});

test("reject virtual-root bindings that omit the shared snap preference adapter",()=>{
  const incomplete='createParameterBinding(descriptor); createParameterUnitSwitch(options); frequencyBindings.F.value; frequencyBindings.H.value;';
  assert.match(auditUnitConsumer("virtual-root-workbench.mjs",incomplete).join("\\n"),
    /snap interactions must reuse attachParameterSnapControls/);
});

test("G5: reject duplicate HTML IDs but preserve valid existing help markup",()=>{
  assert.deepEqual(auditStaticMarkup("index.html",
    '<div id="a"></div><details class="info-tip" id="help"><summary>?</summary></details>'),[]);
  assert.match(auditStaticMarkup("index.html",
    '<div id="same"></div><section id="same"></section>').join("\n"),/duplicate static id/);
});
test("G5: reject independent HTML unit switch, allow a special-purpose rail",()=>{
  assert.match(auditStaticMarkup("index.html",
    '<div class="unit-switch"><button data-unit="hz">Hz</button></div>').join("\n"),
    /shared UI owner/);
  assert.deepEqual(auditStaticMarkup("index.html",
    '<div id="custom"><input type="range" aria-label="反射量"></div>'),[]);
});
test("G5: reject copied JavaScript unit icons without the shared owner",()=>{
  const copied='const root=document.createElement("div");root.className="unit-switch";';
  assert.match(auditUnitConsumer("new-classic-ui.js",copied).join("\n"),
    /generic unit switch must reuse/);
  assert.deepEqual(auditUnitConsumer("new-classic-ui.js",
    copied+" const buttons=createParameterUnitSwitch({doc,choices,selected,onSelect});"),[]);
});
test("G5: standard ranges must keep token owner; reflect variant stays distinct",()=>{
  const bad='.vr-control input[type="range"]{accent-color:#ff00aa}';
  assert.match(auditSharedControlStyles("style.css",bad).join("\n"),
    /--fw-ui-range-accent/);
  assert.deepEqual(auditSharedControlStyles("style.css",
    '.settings-body input[type=range]{accent-color:var(--fw-ui-range-accent)}'+
    '.quick-panel .reflect-control .reflect-row input[type=range]{accent-color:#58e0ba}'),[]);
});
test("G5: tree scan actually includes classic JS and static document/CSS",()=>{
  const root=mkdtempSync(join(tmpdir(),"fw-g5-reuse-"));
  try{
    writeFileSync(join(root,"copied-ui.js"),
      'const root=document.createElement("div");root.className="unit-switch";');
    writeFileSync(join(root,"index.html"),'<div id="duplicate"></div><div id="duplicate"></div>');
    writeFileSync(join(root,"style.css"),
      '.settings-body input[type=range]{accent-color:#ff0000}');
    const result=auditWebModuleTree(root).join("\n");
    assert.match(result,/copied-ui\.js: generic unit switch/);
    assert.match(result,/index\.html: duplicate static id/);
    assert.match(result,/style\.css: shared standard range/);
  }finally{rmSync(root,{recursive:true,force:true});}
});
