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
    this.inputView = null;
    this.outputView = null;
    this.latency = 0;
    this.delay = [];
    this.position = 0;
    this.blocks = 0;
    this.renderCost = 0;
    this.overBudget = 0;
    this.inputEnergy = 0;
    this.wetEnergy = 0;
    this.recentInputEnergy = 0;
    this.recentWetEnergy = 0;
    this.recentSamples = 0;
    this.lastGoodSettings = null;
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
        "warp_stream_create_ext","warp_stream_set_ext",
        "warp_stream_process","warp_stream_latency","warp_stream_set_crusher",
        "warp_stream_set_transform","warp_stream_set_geometry","warp_stream_set_a_options","warp_stream_set_a_band","warp_stream_set_a_quality","warp_stream_set_zero_reflect_gain","warp_stream_set_zero_reflect_decay"
      ];
      for (const name of required) {
        if (!e[name]) throw Error("Missing shared Rust ABI: " + name);
      }
      const options=data.settings;
      const mode=options.mode==="blend"?1:options.mode==="fold-l"?2:options.mode==="reciprocal"?3:0;
      const channels=data.channels;
      const stream=e.warp_stream_create_ext(
        sampleRate,channels,options.low,options.high,options.curvature,
        options.invert,mode,options.qualityIndex,options.outside==="pass"?1:0,
        options.engine,options.pitchRatio,options.shiftHz,options.carrierHz,
        options.zeroMode,options.hopDiv
      );
      if (!stream) throw Error("Rust streaming DSP initialization failed");
      if(e.warp_stream_set_transform(stream,options.axisShift,
        options.axisReference,options.ringEnabled?1:0,options.rationalEnabled?1:0)!==0){
        e.warp_stream_free(stream);throw Error("Rust frequency-axis mapping failed");
      }
      if(e.warp_stream_set_geometry(stream,options.axisPivot,options.axisSlope)!==0){
        e.warp_stream_free(stream);throw Error("Rust axis pivot/slope failed");
      }
      if(e.warp_stream_set_a_options(stream,options.aMinHz,options.aReverb)!==0 ||
         e.warp_stream_set_a_band(stream,options.aBandBins)!==0 ||
         e.warp_stream_set_a_quality(stream,options.aQuality)!==0){
        e.warp_stream_free(stream);throw Error("Rust A options failed");
      }
      if(e.warp_stream_set_zero_reflect_gain(stream,options.zeroReflectGain)!==0 ||
         e.warp_stream_set_zero_reflect_decay(stream,options.zeroReflectDecay)!==0){
        e.warp_stream_free(stream);throw Error("Rust zero-frequency reflection gain failed");
      }
      if(e.warp_stream_set_crusher(stream,options.crusherBits,options.crusherHold)!==0){
        e.warp_stream_free(stream);throw Error("Rust bitcrusher initialization failed");
      }
      const frames=128*channels;
      const src=e.warp_alloc_f32(frames),dst=e.warp_alloc_f32(frames);
      if (!src || !dst) {
        if (src) e.warp_free_f32(src,frames);
        if (dst) e.warp_free_f32(dst,frames);
        e.warp_stream_free(stream);
        throw Error("WASM audio-block memory allocation failed");
      }
      this.exports=e; this.stream=stream;this.src=src;this.dst=dst;this.channels=channels;
      this.inputView=new Float32Array(e.memory.buffer,src,frames);
      this.outputView=new Float32Array(e.memory.buffer,dst,frames);
      this.latency=e.warp_stream_latency(stream);
      this.delay=Array.from({length:channels},()=>new Float32Array(this.latency+256));
      this.position=0;this.blocks=0;this.renderCost=0;this.overBudget=0;
      this.inputEnergy=0;this.wetEnergy=0;
      this.recentInputEnergy=0;this.recentWetEnergy=0;this.recentSamples=0;
      // Created and configured in full before the first "ready" ACK.
      this.lastGoodSettings={...options};
      this.port.postMessage({type:"ready",latencyFrames:this.latency,sampleRate});
    } catch(err) {
      this.port.postMessage({type:"error",message:String(err.message||err)});
    }
  }
  release() {
    this.lastGoodSettings=null;
    if (!this.exports) return;
    const e=this.exports;
    if(this.stream)e.warp_stream_free(this.stream);
    const count=128*this.channels;
    if(this.src)e.warp_free_f32(this.src,count);
    if(this.dst)e.warp_free_f32(this.dst,count);
    this.stream=0;this.src=0;this.dst=0;this.exports=null;
    this.inputView=null;this.outputView=null;
  }
  // Apply one complete numeric snapshot in the same Rust-setter order used
  // by the initial stream. Only call this on a params message, never in the
  // 128-frame rendering loop. No normal-success-path allocation is needed.
  applySettings(p) {
    const e=this.exports,stream=this.stream;
    const mode=p.mode==="blend"?1:p.mode==="fold-l"?2:p.mode==="reciprocal"?3:0;
    const code=e.warp_stream_set_ext(stream,p.low,p.high,p.curvature,p.invert,
      mode,p.qualityIndex,p.outside==="pass"?1:0,p.engine,p.pitchRatio,
      p.shiftHz,p.carrierHz,p.zeroMode);
    if(code!==0)return code;
    const axis=e.warp_stream_set_transform(stream,p.axisShift,p.axisReference,
      p.ringEnabled?1:0,p.rationalEnabled?1:0);
    if(axis!==0)return axis;
    const geometry=e.warp_stream_set_geometry(stream,p.axisPivot,p.axisSlope);
    if(geometry!==0)return geometry;
    const a=e.warp_stream_set_a_options(stream,p.aMinHz,p.aReverb);
    if(a!==0)return a;
    const band=e.warp_stream_set_a_band(stream,p.aBandBins);
    if(band!==0)return band;
    const quality=e.warp_stream_set_a_quality(stream,p.aQuality);
    if(quality!==0)return quality;
    const zero=e.warp_stream_set_zero_reflect_gain(stream,p.zeroReflectGain);
    if(zero!==0)return zero;
    const decay=e.warp_stream_set_zero_reflect_decay(stream,p.zeroReflectDecay);
    if(decay!==0)return decay;
    return e.warp_stream_set_crusher(stream,p.crusherBits,p.crusherHold);
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
      // Seek/reset starts a new recent-signal diagnostic interval.
      this.recentInputEnergy=0;this.recentWetEnergy=0;this.recentSamples=0;
    } else if (data.type==="params") {
      const p=data.settings;
      // Different FFT sizes require a state/latency rebuild.
      if (p.qualityIndex!==data.activeQualityIndex) {
        this.port.postMessage({type:"rebuild-needed",settings:p});
        return;
      }
      const code=this.applySettings(p);
      if(code===0){
        this.lastGoodSettings={...p};
        this.port.postMessage({type:"parameters-applied",revision:data.revision});
        return;
      }
      // A later setter can fail after earlier setters changed the stream.
      // Reapply the last complete ACKed numeric snapshot rather than leave
      // partly mutated parameters sounding as though they were accepted.
      // DSP history (e.g. reverb/FFT buffers) may have reset, and is NOT a
      // bit-exact transaction rollback of earlier audio frames.
      const previous=this.lastGoodSettings;
      const restored=previous&&this.applySettings(previous)===0;
      if(restored){
        this.port.postMessage({
          type:"error",revision:data.revision,recovered:true,
          message:"Rust DSP parameter status "+code+
            " · 前回の正常設定値へ復旧（DSP内部状態は一部リセットされる可能性）"
        });
      }else{
        // A failed rollback means wet output is no longer trustworthy.
        // Stop this partial stream and ask the UI to restore direct original.
        this.release();
        this.port.postMessage({
          type:"error",revision:data.revision,fatal:true,
          message:"Rust DSP parameter status "+code+
            " · 復旧失敗のため変換を停止し原音へ退避"
        });
      }
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
    const inp=this.inputView;
    const out=this.outputView;
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
        outputDry[i]=this.latency===0?inp[c*frames+i]:ring[read];
        ring[slot]=inp[c*frames+i];
        outputWet[i]=out[c*frames+i];
        const inSquare=inp[c*frames+i]*inp[c*frames+i];
        const outSquare=outputWet[i]*outputWet[i];
        this.inputEnergy+=inSquare;this.wetEnergy+=outSquare;
        this.recentInputEnergy+=inSquare;this.recentWetEnergy+=outSquare;
      }
    }
    this.position+=frames;
    this.recentSamples+=frames*this.channels;
    if(t0){
      const ms=(globalThis.performance?.now?.()||t0)-t0;
      this.renderCost+=ms;
      if(ms>1000*frames/sampleRate)this.overBudget++;
    }
    if(++this.blocks%160===0){
      const n=this.recentSamples;
      this.port.postMessage({
        type:"stats",blocks:this.blocks,latencyFrames:this.latency,
        averageBlockMs:this.renderCost/this.blocks,
        overBudgetBlocks:this.overBudget,
        windowSeconds:n/(this.channels*sampleRate),
        inputRms:n?Math.sqrt(this.recentInputEnergy/n):0,
        outputRms:n?Math.sqrt(this.recentWetEnergy/n):0,
        sessionInputRms:Math.sqrt(this.inputEnergy/(this.blocks*frames*this.channels)),
        sessionOutputRms:Math.sqrt(this.wetEnergy/(this.blocks*frames*this.channels))
      });
      // Unlike lifetime CPU counters, these meters describe only the most
      // recent bounded sample window and do not stay loud after silence.
      this.recentInputEnergy=0;this.recentWetEnergy=0;this.recentSamples=0;
    }
    return true;
  }
}
registerProcessor("frequency-warp-rust",FrequencyWarpProcessor);
