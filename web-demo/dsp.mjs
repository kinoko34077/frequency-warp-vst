/** Browser adapters only. All spectral transforms and frequency mapping are
 * the Rust core in native/WASM. Mapping oracle moved to test-only module. */
export const QUALITY=Object.freeze({
  eco:{fftSize:1024,hop:256},
  standard:{fftSize:2048,hop:256},
  high:{fftSize:4096,hop:512}
});
export function mixWet(dry,processed,wet){
  if(!Number.isFinite(wet)||wet<0||wet>1||dry.length!==processed.length)
    throw new RangeError("Invalid Wet or channel lengths");
  return Float32Array.from(dry,(x,i)=>(1-wet)*x+wet*processed[i]);
}
