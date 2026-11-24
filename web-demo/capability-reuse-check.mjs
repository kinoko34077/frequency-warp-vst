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
    else if(item.isFile()&&/\.(?:mjs|js)$/.test(item.name)&&!/\.test\.(?:mjs|js)$/.test(item.name))
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
  // A consumer must not build a second generic icon switch behind a unit
  // binding. The canonical adapter itself is allowlisted above.
  const createsUnitIcons=
    /\bclassName\s*=\s*["'\x60][^"'\x60]*\bunit-switch\b/.test(source)||
    /\bclassList\.add\(\s*["'\x60]unit-switch["'\x60]/.test(source)||
    /<[\w:-]+[^>]*\bclass\s*=\s*["'][^"']*\bunit-switch\b/i.test(source);
  if(createsUnitIcons&&!usesFieldAdapter&&!usesSharedSwitch)
    errors.push(file+": generic unit switch must reuse the shared UI adapter");
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
/** G5: finite checks of static HTML, not a semantic DOM equivalence proof. */
export function auditStaticMarkup(file,source){
  const errors=[],seen=new Set();
  // Check actual start tags, not text-only ID references in scripts.
  for(const tag of source.matchAll(/<[a-z][^>]*>/gi)){
    const id=/\bid\s*=\s*(["'])([^"']+)\1/i.exec(tag[0]);
    if(!id)continue;
    if(seen.has(id[2]))errors.push(file+": duplicate static id "+id[2]);
    seen.add(id[2]);
  }
  // All generic unit buttons are created by createParameterUnitSwitch.
  // Specialized number/gesture inputs may use their own semantic markup.
  if(/<[a-z][^>]*\bclass\s*=\s*(["'])[^"']*\bunit-switch\b[^"']*\1[^>]*>/i.test(source)||
     /<[a-z][^>]*\bdata-unit\s*=/i.test(source))
    errors.push(file+": static unit switch bypasses the shared UI owner");
  return errors;
}

/** G5: only known standard ranges share this accent token. Specialized
 * reflect/checkbox/progress variants are deliberately NOT classified as
 * equivalent controls by a selector-only check. */
export function auditSharedControlStyles(file,source){
  const errors=[];
  for(const rule of source.matchAll(/([^{}]+)\{([^{}]*)\}/g)){
    if(!/\.(?:settings-body|vr-control)\b[^{}]*\binput\s*\[\s*type\s*=\s*["']?range["']?\s*\]/i.test(rule[1]))
      continue;
    const color=/(?:^|;)\s*accent-color\s*:\s*([^;]+)\s*(?:;|$)/i.exec(rule[2]);
    if(color&&!/^var\(\s*--fw-ui-range-accent\s*\)$/.test(color[1].trim()))
      errors.push(file+": shared standard range must use --fw-ui-range-accent");
  }
  return errors;
}

export function auditWebModuleTree(root=localDir){
  const errors=[];
  for(const path of modulesUnder(root)){
    const file=relative(root,path).replaceAll("\\","/");
    errors.push(...auditUnitConsumer(file,readFileSync(path,"utf8")));
  }
  for(const item of readdirSync(root,{withFileTypes:true})){
    if(!item.isFile())continue;
    const file=item.name,sourcePath=join(root,file);
    if(file.endsWith(".html"))
      errors.push(...auditStaticMarkup(file,readFileSync(sourcePath,"utf8")));
    if(file==="style.css")
      errors.push(...auditSharedControlStyles(file,readFileSync(sourcePath,"utf8")));
  }
  return errors;
}
