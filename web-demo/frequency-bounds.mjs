/** #79: one canonical L/H reconciliation for slider, typed entry and DSP.
 * Keep the user's edited edge whenever possible, moving its peer instead.
 * No DOM, WASM or display rounding belongs in this pure physical-Hz rule. */
export function reconcileFrequencyBounds({low,high,cap,changed="",min=0.001}){
  for(const [name,value] of Object.entries({low,high,cap,min})){
    if(!Number.isFinite(value))throw new RangeError(name+" must be finite");
  }
  if(min<=0||cap<=min*1.08)throw new RangeError("invalid frequency limits");
  const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
  // Reserve enough space for a valid peer even at 0.001 Hz and Nyquist cap.
  let L=clamp(low,min,cap/1.08),H=clamp(high,min*1.08,cap);
  if(H<L*1.06){
    if(changed==="low")H=Math.min(cap,L*1.08);
    else L=Math.max(min,H/1.08);
  }
  return Object.freeze({low:L,high:H});
}
