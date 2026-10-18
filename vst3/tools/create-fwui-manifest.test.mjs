import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,mkdir,writeFile,readFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import {createHash} from "node:crypto";
const tool=fileURLToPath(new URL("./create-fwui-manifest.mjs",import.meta.url));
test("unsigned manifest is reproducible, external to UI root and non-overwriting",async()=>{
  const workspace=await mkdtemp(join(tmpdir(),"fw-ui-manifest-"));
  try{
    const root=join(workspace,"ui");await mkdir(root);
    const html="<!doctype html><h1>Test</h1>";
    const js="export const ready=true;";
    await writeFile(join(root,"index.html"),html);
    await writeFile(join(root,"host-bridge.mjs"),js);
    const run=spawnSync(process.execPath,[tool,root],{encoding:"utf8"});
    assert.equal(run.status,0,run.stderr);
    const expected="FWUI-MANIFEST-V1\n"+
      "host-bridge.mjs\t"+Buffer.byteLength(js)+"\t"+
      createHash("sha256").update(js).digest("hex")+"\n"+
      "index.html\t"+Buffer.byteLength(html)+"\t"+
      createHash("sha256").update(html).digest("hex")+"\n";
    assert.equal(await readFile(join(workspace,"manifest.fwui"),"utf8"),expected);
    const duplicate=spawnSync(process.execPath,[tool,root],{encoding:"utf8"});
    assert.notEqual(duplicate.status,0,"manifest may not overwrite an approved snapshot");
  }finally{await rm(workspace,{recursive:true,force:true});}
});
