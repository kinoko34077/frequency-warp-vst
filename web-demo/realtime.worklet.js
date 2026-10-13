/**
 * True continuous 128-frame DSP on Web Audio's rendering thread.
 * The spectral transform is native Rust stream.rs compiled into shared WASM,
 * not a copy of the audio algorithm in JavaScript.
 *
 * Output 0: transformed wet; output 1: dry delayed by reported FFT lookahead.
 */
class FrequencyWarpProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.exports = null;
    this.stream = 0;
    this.channels = 0;
    this.src = 0;
    this.dst = 0;
    this.latency = 0;
    this.delay = [];
    this.position = 0;
    this.blocks = 0;
    this.renderCost = 0;
    this.overBudget = 0;
    this.port.onmessage = ({data}) => this.command(data);
  }
  initialize(data) {
    try {
      if (this.stream) this.release();
      const instance = new WebAssembly.Instance(new WebAssembly.Module(data.bytes), {});
      const e = instance.exports;
      const required = [
        "memory","warp_alloc_f32","warp_free_f32","warp_stream_create",
        "warp_stream_free","warp_stream_reset","warp_stream_set",
        "warp_stream_process","warp_stream_latency"
      ];
      for (const name of required) {
        if (!e[name]) throw Error("Missing shared Rust ABI: " + name);
      }
      const options=data.settings;
      const mode=options.mode==="blend"?1:options.mode==="fold-l"?2:0;
      const channels=data.channels;
      const stream=e.warp_stream_create(
        sampleRate,channels,options.low,options.high,options.curvature,
        options.invert,mode,options.qualityIndex,options.outside==="pass"?1:0
      );
      if (!stream) throw Error("Rust streaming DSP initialization failed");
      const frames=128*channels;
      const src=e.warp_alloc_f32(frames),dst=e.warp_alloc_f32(frames);
      if (!src || !dst) {
        if (src) e.warp_free_f32(src,frames);
        if (dst) e.warp_free_f32(dst,frames);
        e.warp_stream_free(stream);
        throw Error("WASM audio-block memory allocation failed");
      }
      this.exports=e; this.stream=stream;this.src=src;this.dst=dst;this.channels=channels;
      this.latency=e.warp_stream_latency(stream);
      this.delay=Array.from({length:channels},()=>new Float32Array(this.latency+256));
      this.position=0;this.blocks=0;this.renderCost=0;this.overBudget=0;
      this.port.postMessage({type:"ready",latencyFrames:this.latency,sampleRate});
    } catch(err) {
      this.port.postMessage({type:"error",message:String(err.message||err)});
    }
  }
  release() {
    if (!this.exports) return;
    const e=this.exports;
    if(this.stream)e.warp_stream_free(this.stream);
    const count=128*this.channels;
    if(this.src)e.warp_free_f32(this.src,count);
    if(this.dst)e.warp_free_f32(this.dst,count);
    this.stream=0;this.src=0;this.dst=0;this.exports=null;
  }
  command(data) {
    if (!data) return;
    if (data.type==="init")return this.initialize(data);
    if (!this.stream)return;
    const e=this.exports;
    if (data.type==="reset") {
      e.warp_stream_reset(this.stream);
      for (const buffer of this.delay)buffer.fill(0);
      this.position=0;
    } else if (data.type==="params") {
      const p=data.settings;
      // Different FFT sizes require a state/latency rebuild.
      if (p.qualityIndex!==data.activeQualityIndex) {
        this.port.postMessage({type:"rebuild-needed",settings:p});
        return;
      }
      const code=e.warp_stream_set(this.stream,p.low,p.high,p.curvature,p.invert,
        p.mode==="blend"?1:p.mode==="fold-l"?2:0,
        p.qualityIndex,p.outside==="pass"?1:0);
      if(code!==0)this.port.postMessage({type:"error",message:"Rust DSP parameter status "+code});
      else this.port.postMessage({type:"parameters-applied",revision:data.revision});
    } else if(data.type==="dispose") {
      this.release();
    }
  }
  process(inputs,outputs) {
    const wet=outputs[0],dry=outputs[1];
    if(!wet||!dry)return true;
    const input=inputs[0]||[];
    for(const channel of wet)channel.fill(0);
    for(const channel of dry)channel.fill(0);
    if(!this.stream||!this.exports)return true;
    const e=this.exports;
    const frames=wet[0].length;
    if(frames!==128)return true;
    const memory=e.memory.buffer;
    const inp=new Float32Array(memory,this.src,frames*this.channels);
    const out=new Float32Array(memory,this.dst,frames*this.channels);
    for(let c=0;c<this.channels;c++){
      const samples=input[c]||input[0];
      const base=c*frames;
      for(let i=0;i<frames;i++)inp[base+i]=samples?samples[i]:0;
    }
    const t0=globalThis.performance?.now?.()||0;
    const status=e.warp_stream_process(this.stream,this.src,this.dst,frames);
    if(status!==0){
      this.port.postMessage({type:"error",message:"Streaming core returned "+status});
      return true;
    }
    // A host-only delay compensates for Rust STFT lookahead on the dry path.
    const ringLen=this.latency+256;
    for(let c=0;c<this.channels;c++){
      const outputWet=wet[c],outputDry=dry[c],ring=this.delay[c];
      if(!outputWet||!outputDry)continue;
      for(let i=0;i<frames;i++){
        const t=this.position+i,slot=t%ringLen;
        const read=(t+ringLen-(this.latency%ringLen))%ringLen;
        outputDry[i]=ring[read];
        ring[slot]=inp[c*frames+i];
        outputWet[i]=out[c*frames+i];
      }
    }
    this.position+=frames;
    if(t0){
      const ms=(globalThis.performance?.now?.()||t0)-t0;
      this.renderCost+=ms;
      if(ms>1000*frames/sampleRate)this.overBudget++;
    }
    if(++this.blocks%160===0){
      this.port.postMessage({
        type:"stats",blocks:this.blocks,latencyFrames:this.latency,
        averageBlockMs:this.renderCost/this.blocks,
        overBudgetBlocks:this.overBudget
      });
    }
    return true;
  }
}
registerProcessor("frequency-warp-rust",FrequencyWarpProcessor);
