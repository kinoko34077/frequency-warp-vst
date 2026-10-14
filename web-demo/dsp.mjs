/** Browser adapters only. All spectral transforms and frequency mapping
 * stay in native/WASM Rust. Mapping oracle is test-only.
 *
 * The shared Rust streaming stage has n-1 frames of latency for all engines.
 * The realtime AudioWorklet aligns its dry output to that latency. Offline
 * rendering must align the dry source to the Wet timeline before partial
 * mixing; otherwise it produces comb filtering not present in live audition.
 */
export const QUALITY=Object.freeze({
  eco:{fftSize:1024,hop:256},
  standard:{fftSize:2048,hop:256},
  high:{fftSize:4096,hop:512}
});
export function latencyForQuality(qualityIndex){
  const sizes=[QUALITY.eco.fftSize,QUALITY.standard.fftSize,QUALITY.high.fftSize];
  if(!Number.isInteger(qualityIndex)||qualityIndex<0||qualityIndex>=sizes.length)
    throw new RangeError("Invalid quality");
  return sizes[qualityIndex]-1;
}
export function mixWet(dry,processed,wet,latencyFrames=0){
  if(!Number.isFinite(wet)||wet<0||wet>1||dry.length!==processed.length||
     !Number.isInteger(latencyFrames)||latencyFrames<0||latencyFrames>dry.length)
    throw new RangeError("Invalid Wet, latency or channel lengths");
  // A fully dry WAV preserves the original without adding artificial silence.
  if(wet===0)return Float32Array.from(dry);
  // At partial Wet the original must be delayed into the processed timeline.
  if(wet===1)return Float32Array.from(processed);
  const dryGain=1-wet;
  return Float32Array.from(processed,(sample,i)=>
    dryGain*(i>=latencyFrames?dry[i-latencyFrames]:0)+wet*sample);
}
