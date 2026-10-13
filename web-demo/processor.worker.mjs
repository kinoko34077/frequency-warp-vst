import { warpOffline } from "./dsp.mjs";

self.onmessage = ({data}) => {
  if (!data || data.type !== "process") return;
  try {
    const channels=data.channels.map(item => new Float32Array(item));
    const result=warpOffline(
      channels,
      data.sampleRate,
      data.settings,
      value => self.postMessage({type:"progress",value})
    );
    self.postMessage(
      {type:"done",channels:result.channels,diagnostics:result.diagnostics},
      result.channels.map(c=>c.buffer)
    );
  } catch (error) {
    self.postMessage({type:"error",message:error instanceof Error?error.message:String(error)});
  }
};
