/** Build a GitHub Pages artifact from the actual static entry dependency graph.
 * Any new import / worker / worklet / fetch("./...") must be staged without
 * manually editing a separate list of JavaScript files.
 * This is a build-only script; no tooling or tests are published.
 */
import {readFile,copyFile,mkdir,rm,writeFile} from "node:fs/promises";
import {resolve,join,dirname,relative,isAbsolute,sep} from "node:path";
import {fileURLToPath} from "node:url";

const here=dirname(fileURLToPath(import.meta.url));
const assetReference=/["']\.\/([A-Za-z0-9_./-]+\.(?:mjs|js|css|wasm|html|svg|png|jpe?g|webp|gif|ico|json|woff2?))["']/gi;
const cssReference=/url\(\s*["']?\.\/([A-Za-z0-9_./-]+\.(?:svg|png|jpe?g|webp|gif|ico|woff2?))["']?\s*\)/gi;

function safePath(name){
  if(name.startsWith("/") || name.split("/").includes("..") || name.includes("\\")){
    throw Error("Unsafe relative Pages asset: "+name);
  }
  return name;
}
export async function collectAssets({sourceDir=here,wasmPath}={}){
  const seen=new Set(),queue=["index.html"];
  while(queue.length){
    const name=safePath(queue.shift());
    if(seen.has(name))continue;
    const location=name==="dsp_core.wasm" && wasmPath
      ?resolve(wasmPath):join(sourceDir,name);
    let data;
    try{data=await readFile(location);}
    catch(error){throw Error("Pages dependency missing: "+name+" ("+location+"): "+error.message);}
    if(!data.length)throw Error("Pages dependency empty: "+name);
    seen.add(name);
    if(name.endsWith(".wasm"))continue;
    const source=data.toString("utf8");
    // Scan literal relative references in HTML, module imports, Worklets,
    // Worker URL constructors and fetch calls. Only reachable files ship.
    for(const pattern of [assetReference,cssReference]){
      pattern.lastIndex=0;
      for(const match of source.matchAll(pattern)){
        if(!seen.has(match[1]))queue.push(match[1]);
      }
    }
  }
  if(!seen.has("app.mjs") || !seen.has("dsp_core.wasm")){
    throw Error("Pages entry graph must reference app.mjs and dsp_core.wasm");
  }
  return [...seen].sort();
}
export async function stageSite({sourceDir=here,outputDir=resolve("_site"),wasmPath}={}){
  const files=await collectAssets({sourceDir,wasmPath});
  const sourceRoot=resolve(sourceDir),dest=resolve(outputDir);
  if(dest===sourceRoot || dest.startsWith(sourceRoot+sep)){
    throw Error("Pages staging destination may not replace the source tree");
  }
  // Clear old staging so an orphan module cannot conceal missing references.
  await rm(dest,{recursive:true,force:true});
  await mkdir(dest,{recursive:true});
  for(const name of files){
    const input=name==="dsp_core.wasm"&&wasmPath?resolve(wasmPath):join(sourceRoot,name);
    const target=join(dest,name);
    await mkdir(dirname(target),{recursive:true});
    await copyFile(input,target);
  }
  await writeFile(join(dest,".nojekyll"),"");
  return files;
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{
    const files=await stageSite({wasmPath:process.argv[2]});
    console.log("GitHub Pages staged "+files.length+" required assets: "+files.join(", "));
  }catch(error){console.error(error);process.exitCode=1;}
}
