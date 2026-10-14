/** Browser export preflight: a count only; never allocate the entire WASM file
 *  before checking the memory bound. The Worker enforces it again. */
export const MAX_EXPORT_SAMPLES=40_000_000;
export function canExportChannels(channels){
  return Array.isArray(channels) && channels.length>=1 && channels.length<=2 &&
    channels.every(c=>Number.isSafeInteger(c?.length)&&c.length>0) &&
    channels.reduce((sum,c)=>sum+c.length,0)<=MAX_EXPORT_SAMPLES;
}
