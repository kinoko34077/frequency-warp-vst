// Deterministic unsigned FWUI manifest for a local directory named "ui".
// Invocation: node vst3/tools/create-fwui-manifest.mjs /path/to/ui
// Output: sibling "manifest.fwui"; OS-selected/confirmed separately in VST3.
import {readdir,lstat,readFile,writeFile} from "node:fs/promises";
import {createHash} from "node:crypto";
import {resolve,basename,dirname,join,relative,sep} from "node:path";
if(process.argv.length!==3)throw new Error("Expected one local UI directory");
const root=resolve(process.argv[2]);
if(basename(root)!=="ui")throw new Error("UI directory must be named ui");
const allowed=new Set([".html",".htm",".css",".js",".mjs",".json",".wasm",
".svg",".png",".jpg",".jpeg",".webp",".gif",".ico",".woff",".woff2",".ttf",".otf",".txt"]);
const fileList=[];
let total=0;
async function visit(directory){
  for(const entry of (await readdir(directory,{withFileTypes:true}))
      .sort((a,b)=>a.name.localeCompare(b.name,"en"))){
    const path=join(directory,entry.name),stat=await lstat(path);
    if(stat.isSymbolicLink()||(!stat.isFile()&&!stat.isDirectory()))
      throw new Error("Rejected symlink or special file: "+entry.name);
    if(stat.isDirectory()){await visit(path);continue;}
    const name=relative(root,path).split(sep).join("/");
    const parts=name.split("/");
    if(!parts.every(p=>{
      if(!/^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(p) ||
         p.endsWith(".")||p.includes("~")||p==="."||p==="..")return false;
      const stem=p.split(".")[0].toUpperCase();
      if(["CON","PRN","AUX","NUL"].includes(stem) ||
         /^(COM|LPT)[1-9]$/.test(stem))return false;
      return true;
    }))throw new Error("Non-portable Windows asset name: "+name);
    const ext=name.slice(name.lastIndexOf(".")).toLowerCase();
    if(!allowed.has(ext))throw new Error("Unsupported asset extension: "+name);
    if(!Number.isSafeInteger(stat.size)||stat.size>8*1024*1024||
       (total+=stat.size)>48*1024*1024||fileList.length>=1024)
      throw new Error("UI asset limit exceeded");
    const bytes=await readFile(path);
    if(bytes.length!==stat.size)throw new Error("Changed file: "+name);
    fileList.push([name,stat.size,
      createHash("sha256").update(bytes).digest("hex")]);
  }
}
await visit(root);
fileList.sort((a,b)=>a[0].localeCompare(b[0],"en"));
if(!fileList.some(f=>f[0]==="index.html"&&f[1]>0)||
   !fileList.some(f=>f[0]==="host-bridge.mjs"&&f[1]>0))
  throw new Error("index.html and host-bridge.mjs required");
const aliases=fileList.map(f=>f[0].toLowerCase());
if(new Set(aliases).size!==aliases.length)
  throw new Error("Duplicate Windows-insensitive asset path");
const text="FWUI-MANIFEST-V1\n"+fileList.map(f=>f.join("\t")+"\n").join("");
const output=join(dirname(root),"manifest.fwui");
await writeFile(output,text,{flag:"wx"});
console.log("Created unsigned content manifest: "+output);
console.log(fileList.length+" files, "+total+" bytes");
console.log("Choose the manifest via the VST3 native OS dialog; SHA-256 does not authenticate a publisher.");
