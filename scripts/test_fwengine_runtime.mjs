// One loader harness is unchanged while the loaded .fwengine file changes.
import {readFileSync, mkdtempSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {spawnSync} from "node:child_process";
import assert from "node:assert/strict";
import {test} from "node:test";
const [verifier,identityPath,halfPath]=process.argv.slice(2);
if(!verifier||!identityPath||!halfPath)throw Error("args: native-verifier identity.fwengine gainhalf.fwengine");
const temp=mkdtempSync(join(tmpdir(),"fwengine-s1-"));
function load(packagePath){
  const wasmPath=join(temp,"verified-"+(packagePath===identityPath?"identity":"half")+".wasm");
  const verify=spawnSync(verifier,[packagePath,wasmPath],{encoding:"utf8"});
  assert.equal(verify.status,0,verify.stderr || verify.stdout);
  const bytes=readFileSync(wasmPath);
  const wasmModule=new WebAssembly.Module(bytes);
  assert.deepEqual(WebAssembly.Module.imports(wasmModule),[],
    "DSP module MUST NOT import network/filesystem/clock/host functions");
  const e=new WebAssembly.Instance(wasmModule,{}).exports;
  for(const symbol of ["memory","fw_abi_major","fw_create","fw_get_latency_frames",
    "fw_process","fw_reset","fw_destroy","fw_input_offset","fw_output_offset",
    "fw_event_offset","fw_event_capacity","fw_event_stride"]){
    assert.ok(e[symbol],"missing stable host ABI "+symbol);
  }
  assert.equal(e.fw_abi_major(),1);
  assert.ok(e.memory.buffer.byteLength<=67108864,"preallocated WASM memory exceeds cap");
  const handle=e.fw_create(48000,2,256);
  assert.ok(handle,"valid runtime configuration required");
  assert.equal(e.fw_get_latency_frames(handle),0);
  assert.equal(e.fw_event_stride(),16,"ParamEvent is (u32,u32,f64)");
  const [src,dst,ev]=[e.fw_input_offset(),e.fw_output_offset(),e.fw_event_offset()];
  const len=256*2*4, mem=e.memory.buffer;
  for(const off of [src,dst])assert.ok(off>0 && off+len<=mem.byteLength && off%4==0);
  assert.ok((src+len<=dst)||(dst+len<=src),"input/output MUST NOT alias");
  assert.ok(ev>0&&ev+e.fw_event_capacity()*e.fw_event_stride()<=mem.byteLength);
  return {e,handle,src,dst,ev};
}
function render(host,gainAtSample){
  const {e,handle,src,dst,ev}=host,frames=256;
  const input=new Float32Array(e.memory.buffer,src,frames*2);
  for(let c=0;c<2;c++)for(let i=0;i<frames;i++)input[c*frames+i]=.8;
  let count=0;
  if(gainAtSample){
    const view=new DataView(e.memory.buffer,ev);
    view.setUint32(0,64,true);
    view.setUint32(4,gainAtSample.offset,true);
    view.setFloat64(8,gainAtSample.gain,true);
    count=1;
  }
  assert.equal(e.fw_process(handle,src,dst,frames,ev,count),0);
  return Float32Array.from(new Float32Array(e.memory.buffer,dst,frames*2));
}
test("one host harness selects two different .fwengine files to change actual stereo PCM",()=>{
  const identity=load(identityPath),half=load(halfPath);
  const lhs=render(identity),rhs=render(half);
  for(let i=0;i<lhs.length;i++){
    assert.ok(Math.abs(lhs[i]-.8)<1e-6,"identity sample "+i);
    assert.ok(Math.abs(rhs[i]-.4)<1e-6,"gain-half sample "+i);
  }
  const lhsAgain=render(identity);
  assert.ok(Math.abs(lhsAgain[0]-.8)<1e-6);
  assert.equal(identity.e.fw_reset(identity.handle),0);
  identity.e.fw_destroy(identity.handle);
  half.e.fw_destroy(half.handle);
});
test("sample-offset host automation uses fixed ParamID 64 and v1 layout",()=>{
  const half=load(halfPath);
  const pcm=render(half,{offset:128,gain:.25});
  assert.ok(Math.abs(pcm[0]-.4)<1e-6);
  assert.ok(Math.abs(pcm[127]-.4)<1e-6);
  assert.ok(Math.abs(pcm[128]-.2)<1e-6);
  assert.ok(Math.abs(pcm[255]-.2)<1e-6);
  assert.ok(Math.abs(pcm[256+127]-.4)<1e-6);
  assert.ok(Math.abs(pcm[256+128]-.2)<1e-6);
  assert.notEqual(half.e.fw_process(half.handle,half.src,half.dst,256,half.ev,999),0);
  assert.notEqual(half.e.fw_process(half.handle,half.src,half.src,256,half.ev,0),0);
  half.e.fw_destroy(half.handle);
});
process.on("exit",()=>rmSync(temp,{recursive:true,force:true}));
