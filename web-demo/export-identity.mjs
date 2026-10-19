/** One WAV render belongs to one successfully loaded source generation and
 * one fully frozen EFFECTIVE DSP settings packet (including Wet Mix).
 * Never use live controls to reinterpret an older processed buffer.
 */
const scalar=v=>typeof v==="boolean"||typeof v==="string"||
  (typeof v==="number"&&Number.isFinite(v));
export function freezeExportIdentity(sourceGeneration,settings){
  if(!Number.isSafeInteger(sourceGeneration)||sourceGeneration<1||!settings||
    typeof settings!=="object"||!Object.keys(settings).length)
    throw Error("Invalid export identity");
  if(Object.values(settings).some(v=>!scalar(v)))throw Error("Non-scalar export setting");
  return Object.freeze({sourceGeneration,settings:Object.freeze({...settings})});
}
export function matchesExportIdentity(identity,sourceGeneration,settings){
  if(!identity||identity.sourceGeneration!==sourceGeneration||
    !settings||typeof settings!=="object")return false;
  const keys=Object.keys(identity.settings);
  return keys.length===Object.keys(settings).length&&
    keys.every(key=>Object.hasOwn(settings,key)&&Object.is(identity.settings[key],settings[key]));
}
