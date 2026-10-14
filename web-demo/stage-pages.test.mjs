import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,mkdir,writeFile,readFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {collectAssets,stageSite} from "./stage-pages.mjs";

test("Pages staging resolves transitive module/worker dependencies and fails closed",async()=>{
  const root=await mkdtemp(join(tmpdir(),"warp-pages-"));
  const src=join(root,"source"),dest=join(root,"site"),wasm=join(root,"compiled.wasm");
  try{
    await mkdir(src);
    await writeFile(join(src,"index.html"),
      '<link rel="stylesheet" href="./style.css"><script type="module" src="./app.mjs"></script>');
    await writeFile(join(src,"style.css"),"body{color:white}");
    await writeFile(join(src,"app.mjs"),
      'import {mode} from "./engine-policy.mjs"; new URL("./worker.mjs",import.meta.url); fetch("./dsp_core.wasm");');
    await writeFile(join(src,"engine-policy.mjs"),'export const mode=1;');
    await writeFile(join(src,"worker.mjs"),'import "./export-policy.mjs";');
    await writeFile(join(src,"export-policy.mjs"),'export const max=40_000_000;');
    await writeFile(wasm,Buffer.from([0,97,115,109,1,0,0,0]));
    const expected=["app.mjs","dsp_core.wasm","engine-policy.mjs","export-policy.mjs","index.html","style.css","worker.mjs"];
    assert.deepEqual(await collectAssets({sourceDir:src,wasmPath:wasm}),expected);
    assert.deepEqual(await stageSite({sourceDir:src,outputDir:dest,wasmPath:wasm}),expected);
    assert.match(await readFile(join(dest,"worker.mjs"),"utf8"),/export-policy.mjs/);
    // New imports must be auto-staged; no human-maintained allow-list exists.
    await writeFile(join(src,"export-policy.mjs"),'import "./not-staged-yet.mjs";');
    await assert.rejects(()=>collectAssets({sourceDir:src,wasmPath:wasm}),/Pages dependency missing: not-staged-yet.mjs/);
    // Missing compiled WASM is equally fatal, even though source UI exists.
    await assert.rejects(()=>collectAssets({sourceDir:src,wasmPath:join(root,"absent.wasm")}),
      /Pages dependency missing: dsp_core.wasm/);
  }finally{await rm(root,{recursive:true,force:true});}
});
