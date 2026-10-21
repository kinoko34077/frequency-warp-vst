/** #79 / devflow #758: structural reuse guard for new Web numeric-unit interfaces.
 * This is a scoped regression gate, not a proof against every semantic duplicate.
 */
import {readFileSync,readdirSync} from "node:fs";
import {resolve,relative,join,dirname} from "node:path";
import {fileURLToPath} from "node:url";

const localDir=dirname(fileURLToPath(import.meta.url));
const ignored=new Set([
  "parameter-units.mjs", // canonical codec owner
  "parameter-binding.mjs", // canonical binding owner
  "frequency-unit-field.mjs" // canonical UI adapter owner
]);
function modulesUnder(path){
  const files=[];
  for(const item of readdirSync(path,{withFileTypes:true})){
    const entry=join(path,item.name);
    if(item.isDirectory())files.push(...modulesUnder(entry));
    else if(item.isFile()&&item.name.endsWith(".mjs")&&!item.name.endsWith(".test.mjs"))
      files.push(entry);
  }
  return files;
}
export function auditUnitConsumer(file,source){
  const errors=[];
  if(ignored.has(file))return errors;
  const hasUnitSwitch=/unit-switch|data-vr-unit|unitSelector|unitButtons|data-unit/.test(source);
  const hasEditor=/\bparseView\b|\bformatView\b|\bhzToNoteCents\b|\bnoteCentsToHz\b|\bfromText\b|addEventListener\(["']input/.test(source);
  const hasBinding=/\bcreateParameterBinding\s*\(|\bmount(?:Parameter|Frequency)UnitField\s*\(/.test(source);
  if(hasUnitSwitch&&hasEditor&&!hasBinding)
    errors.push(file+": numeric-unit UI must consume the canonical parameter binding or mounted UI adapter");
  const usesFieldAdapter=/\bmount(?:Parameter|Frequency)UnitField\s*\(/.test(source);
  const usesSharedSwitch=/\bcreateParameterUnitSwitch\s*\(/.test(source);
  if(hasUnitSwitch&&hasEditor&&hasBinding&&!usesFieldAdapter&&!usesSharedSwitch)
    errors.push(file+": numeric-unit icon UI must reuse createParameterUnitSwitch, not generate independent icon buttons");
  if(file==="app.mjs"){
    if(!/\bmountPercentParameterField\s*\(/.test(source))
      errors.push(file+": canonical percent editors must reuse mountPercentParameterField");
    if(/\b(?:const|let|function)\s+commit(?:Wet|AReverb|ZeroReflect|ZeroDecay|Invert)Typed\b/.test(source))
      errors.push(file+": copied typed-percent input controllers are forbidden");
  }
  if(file==="virtual-root-workbench.mjs"){
    if(!usesSharedSwitch)errors.push(file+": virtual-root unit icons must use the common component");
    if(!/\battachParameterSnapControls\s*\(/.test(source))
      errors.push(file+": virtual-root snap interactions must reuse attachParameterSnapControls");
    if(!/\bcreateParameterBinding\s*\(/.test(source))
      errors.push(file+": F/H must be owned by shared canonical bindings");
    if(/const\s+units\s*=\s*\{\s*F\s*:/.test(source))
      errors.push(file+": parallel F/H display-unit state is forbidden");
    if(/const\s+state\s*=\s*\{\s*F\s*:/.test(source))
      errors.push(file+": parallel F/H canonical Hz state is forbidden");
    if(!/frequencyBindings\.F\.value/.test(source)||!/frequencyBindings\.H\.value/.test(source))
      errors.push(file+": F/H must derive displayed/processed Hz from binding values");
  }
  return errors;
}
export function auditWebModuleTree(root=localDir){
  const errors=[];
  for(const path of modulesUnder(root)){
    const file=relative(root,path).replaceAll("\\","/");
    errors.push(...auditUnitConsumer(file,readFileSync(path,"utf8")));
  }
  return errors;
}
