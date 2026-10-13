# Shared Audio DSP Architecture (R2.1 research baseline)

The **only production-path audio transformation implementation** is
\`core/src/lib.rs\`, a std-only Rust library. The codebase compiles to:

- **native** \`staticlib\` + \`rlib\` and the \`warp_process_f32\` C ABI,
  intended as the future VST3 adapter's core;
- **wasm32-unknown-unknown** \`cdylib\`, loaded by
  \`web-demo/processor.worker.mjs\` and used in the browser.

Thus VST3 and browser clients call **the same Rust DSP algorithm**, not
separately maintained Python/JS transforms. Python R0/R1/R2.1 remains
research and controlled comparison, NOT the deployable engine.

## Native / WASM C ABI

\`warp_alloc_f32(count) -> f32*\`
\`warp_free_f32(ptr,count)\`
\`warp_map_frequency(f,low,high,p,invert,mode) -> f64\`
\`warp_process_f32(input,output,frames,channels,sample_rate,low,high,p,invert,mode,quality) -> i32\`

Audio buffers are **planar contiguous f32** (all samples for left channel,
then all for right). A 0 status means success; negative means invalid
input or research boundary. Source and destination **must not overlap**.
Callers own buffer lifetime and alignment. Mode 0=Fold / 1=Blend.
Quality 0=Eco (N1024/hop256/6 peaks), 1=Standard (N2048/hop256/10),
2=High (N4096/hop512/18). Core owns the actual parameter validation
and frequency warping. Wet mixing is deliberately a host-adapter concern;
WebAudio does this after rendering, and VST3 will do the same.

**Not realtime safe yet**: \`warp_process_f32\` assumes an entire audio
buffer and allocates internally; later VST3 requires a streaming
\`prepare/process_block/reset\` stateful ABI with bounded latency, no
allocation on audio thread and cross-block phase continuity. Merely
linking native Rust does not create a VST3 plugin.

## Test and build

\`\`\`sh
cargo test --manifest-path core/Cargo.toml
rustup target add wasm32-unknown-unknown
cargo build --manifest-path core/Cargo.toml --release --target wasm32-unknown-unknown
cp core/target/wasm32-unknown-unknown/release/frequency_warp_core.wasm web-demo/dsp_core.wasm
node --test web-demo/core-wasm.test.mjs
python3 -m http.server 8000
# Open http://localhost:8000/web-demo/
\`\`\`

\`web-demo/dsp.mjs\` now contains only graph projection, UI quality
labels and post-render Wet interpolation. It no longer exports or
implements any audio FFT/STFT engine.

## Product and quality caveats

- This is the **same unselected R2.1 algorithm**. Actual studio-quality
  DSP will depend on R2.2/R2.3 comparison; no improved fidelity is claimed.
- Offline duration is **up to 120 seconds** in the Web UI, at the cost
  of substantially more CPU/memory; the Rust core caps at 180 seconds
  to prevent unbounded misuse from clients. Quality and duration determine
  render time. Worker prevents UI thread freeze, but entire render is
  still a single blocking call within the worker, so progress only marks
  start and completion.
- Frequency bounds are still the narrow *test-analysis band*, not an
  accepted policy for DC, Nyquist or out-of-band input.
- The Web endpoint decodes local user files in browser; no file upload
  or external audio processing service.
- Pages deploys only the static browser assets and wasm binary, not
  the research corpus or test audio.
