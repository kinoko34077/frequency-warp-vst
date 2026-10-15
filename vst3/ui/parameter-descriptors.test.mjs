import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {SCHEMA,validateDescriptors,parseDescriptors,toPhysical,toNormalized} from "./parameter-descriptors.mjs";
import {UNIT_KINDS,noteCentsToHz} from "../../web-demo/parameter-units.mjs";

const make = (overrides={}) => ({
  host_slot:64,semantic_id:"gain",label:"Output gain",
  dimension:"fraction",canonical_unit:"fraction",
  min:0,max:1,default:.5,scale:"linear",widget:"knob",
  display_units:["percent"],codec_revision:1,...overrides
});
const pkg = (bindings=[make()]) => ({
  schema:SCHEMA,
  engine:{id:"org.example.processor",version:"0.1.0",
    sha256:"ab".repeat(32)},
  bindings
});
const clone=o=>structuredClone(o);
function invalid(variant, note) {
  assert.equal(validateDescriptors(pkg([variant])),false,note);
  assert.throws(()=>parseDescriptors(JSON.stringify(pkg([variant]))),RangeError,note);
}
test("schema contract is strict and parseable as JSON",async()=>{
  const path=new URL("../../schemas/fw-ui-descriptors-v1.schema.json",import.meta.url);
  const schema=JSON.parse(await readFile(path,"utf8"));
  assert.equal(schema.properties.schema.const,SCHEMA);
  assert.equal(schema.additionalProperties,false);
  assert.equal(schema.properties.bindings.maxItems,64);
  assert.equal(schema.$defs.binding.properties.host_slot.minimum,64);
  assert.equal(schema.$defs.binding.properties.host_slot.maximum,127);
});
test("valid independent generic slots, format roundtrip and bounds",()=>{
  const data=pkg([
    make(),
    make({host_slot:65,semantic_id:"low",label:"Lower",
      dimension:"frequency",canonical_unit:"hz",
      min:.001,max:20000,default:20,scale:"frequency-band",
      widget:"slider",display_units:["hz","note","percent"]}),
    make({host_slot:66,semantic_id:"enable",label:"Enable",
      dimension:"boolean",canonical_unit:"boolean",
      min:0,max:1,default:0,scale:"discrete",steps:1,
      widget:"switch",display_units:["boolean"]})
  ]);
  assert.equal(validateDescriptors(data),true);
  assert.deepEqual(parseDescriptors(JSON.stringify(data)),data);
  assert.ok(Math.abs(toPhysical(data.bindings[1],0.2)-20)<1e-10,
    "20Hz frequency-band breakpoint allows floating precision");
  assert.ok(Math.abs(toNormalized(data.bindings[1],20)-.2)<1e-12);
  assert.equal(toPhysical(data.bindings[2],.8),1);
  assert.equal(toNormalized(data.bindings[2],0),0);
  assert.ok(UNIT_KINDS.frequency.includes("note"));
  assert.equal(noteCentsToHz("A4"),440);
});
test("bounded host slots and semantic isolation before native R2",()=>{
  invalid(make({host_slot:33}),"named shell ID must not rebind");
  invalid(make({host_slot:128}),"beyond host limit");
  invalid(make({host_slot:34}),"native reserved slot");
  invalid(make({semantic_id:"gain/evil"}),"semantic path unsafe");
  invalid(make({selector:"#gain:hover"}),"selector unsafe");
  invalid(make({label:"Name\nwith code"}),"label contains control character");
  invalid(make({dimension:"fraction",canonical_unit:"hz"}),"dimension mismatch");
  invalid(make({display_units:["hz"]}),"illegal fraction unit");
  invalid(make({display_units:["percent","percent"]}),"duplicate units");
  invalid(make({codec_revision:0}),"codec version");
  invalid(make({default:Infinity}),"non-finite default");
  invalid(make({default:-.1}),"default below range");
  invalid(make({min:1,max:0}),"reversed bounds");
  invalid(make({scale:"log"}),"log fraction with zero minimum");
  invalid(make({scale:"frequency-band"}),"frequency-band requires exact 20Hz pivot");
  invalid(make({scale:"frequency-with-zero"}),"zero scale must be 0..20000Hz");
  invalid(make({steps:100}),"step only on discrete scale");
  invalid(make({widget:"native-dll"}),"widget allowlist");
});
test("cross-descriptor duplicates, dependencies, cycles and unexpected JSON keys",()=>{
  const sameSlot=pkg([make(),make({semantic_id:"other",selector:"#other"})]);
  assert.equal(validateDescriptors(sameSlot),false);
  const sameSemantic=pkg([make(),make({host_slot:65})]);
  assert.equal(validateDescriptors(sameSemantic),false);
  const deps=pkg([
    make({depends_on:["other"]}),
    make({host_slot:65,semantic_id:"other"})
  ]);
  assert.equal(validateDescriptors(deps),true);
  deps.bindings[1].depends_on=["gain"];
  assert.equal(validateDescriptors(deps),false,"dependency cycle");
  deps.bindings[1].depends_on=["missing"];
  assert.equal(validateDescriptors(deps),false,"missing dependency");
  const broken=pkg();
  broken.engine.foo=1;
  assert.equal(validateDescriptors(broken),false,"unknown metadata rejected");
  const proto=pkg();
  proto.bindings[0].__proto__={evil:1};
  assert.equal(validateDescriptors(proto),false,"unsafe inherited fields rejected");
  const extra=pkg();
  extra.bindings[0].binary="unsafe.dll";
  assert.equal(validateDescriptors(extra),false);
  const nested=JSON.stringify(pkg())+" ".repeat(66000);
  assert.throws(()=>parseDescriptors(nested),RangeError);
  const utf8=JSON.stringify(pkg([make({label:"木".repeat(22000)})]));
  assert.ok(utf8.length<65536 && new TextEncoder().encode(utf8).byteLength>65536);
  assert.throws(()=>parseDescriptors(utf8),/descriptor byte limit/);
});
test("physical curve and zero-frequency handling match fixed host transfer",()=>{
  const band=make({dimension:"frequency",canonical_unit:"hz",
    min:.001,max:20000,default:20,scale:"frequency-band",
    display_units:["hz","note","percent"]});
  const zero=make({dimension:"frequency",canonical_unit:"hz",
    min:0,max:20000,default:350,scale:"frequency-with-zero",
    display_units:["hz","percent"]});
  const log=make({dimension:"ratio",canonical_unit:"ratio",
    min:.25,max:4,default:1,scale:"log",
    display_units:["ratio","semitones","cents"]});
  for(const b of [band,log])for(let i=0;i<=100;i++){
    const n=i/100;
    assert.ok(Math.abs(toNormalized(b,toPhysical(b,n))-n)<1e-10,
      "curve mismatch "+JSON.stringify({n,scale:b.scale}));
  }
  assert.equal(toPhysical(zero,0),0);
  assert.equal(toNormalized(zero,0),0);
  assert.ok(Math.abs(toPhysical(zero,.2)-20)<1e-8);
  assert.ok(Math.abs(toNormalized(zero,20)-.2)<1e-10);
  assert.throws(()=>toPhysical(zero,NaN),RangeError);
  assert.throws(()=>toPhysical(zero,1.1),RangeError);
  assert.throws(()=>toNormalized(zero,-1),RangeError);
});
test("discrete and snap targets with explicit normalized capture radius",()=>{
  const count=make({dimension:"integer",canonical_unit:"integer",
    min:1,max:8,default:1,scale:"discrete",steps:7,
    display_units:["integer","percent"],widget:"select"});
  assert.equal(toPhysical(count,.4),4);
  assert.equal(toNormalized(count,4),3/7);
  invalid({...count,steps:8},"integer step contract");
  const snap=make({snap:{values:[0,.5,1],radius_normalized:.06}});
  assert.equal(toPhysical(snap,.54,true),.5);
  assert.equal(toPhysical(snap,.60,true),.60);
  assert.equal(toPhysical(snap,.54,false),.54);
  invalid(make({snap:{values:[0,1.1],radius_normalized:.05}}),"out of bounds snap");
  invalid(make({snap:{values:[0,.5],radius_normalized:-.1}}),"negative snap radius");
});
test("engine identity constraints, duplicate descriptor and payload cap",()=>{
  assert.equal(validateDescriptors(pkg(Array.from({length:64},(_,i)=>
    make({host_slot:64+i,semantic_id:"gain_"+i,selector:"#gain-"+i})))),true);
  assert.equal(validateDescriptors(pkg(Array.from({length:65},(_,i)=>
    make({host_slot:64+i,semantic_id:"gain_"+i})))),false);
  const broken=pkg();
  broken.engine.sha256="00";
  assert.equal(validateDescriptors(broken),false);
  assert.equal(validateDescriptors(pkg([])),true);
  assert.equal(validateDescriptors({...pkg(), extra:true}),false);
  assert.throws(()=>parseDescriptors("{"),TypeError);
});
