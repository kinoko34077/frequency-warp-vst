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

## 2026-10-13 Web effect controls (Issue #12)
- L/H are user-controlled research analysis bounds. The Web sliders are logarithmic
  20Hz–20kHz with high limited to 45% of the file's current decode sample rate
  and a small strictly-positive separation between L and H.
- Three invert-progress modes are controlled by the SAME Rust DSP. The signed
  normalized coordinate advances towards H for mode 0, towards L for mode 2,
  and frequency blending is mode 1. At invert=1 all three arrive at the same
  endpoint-exchanging inversion; at intermediate invert they differ. Mode 1
  can substantially collapse/compress energy near invert=.5.
- Input frequencies **outside [L,H]**: Pass vs Kill are now explicit user
  options. In Pass mode the **complementary FFT spectral bins** are
  reconstructed with a real inverse FFT, then overlap-added, rather than
  mixing the raw full-band original into the wet output. Near L/H cutoffs
  the finite FFT window permits leakage; no perfect brickwall selection is
  claimed. Untracked in-band residual remains an R2-quality limitation.
  This decision is wholly separate from 0Hz-or-negative target
  Reflect/Kill/Fade, which has NOT been implemented yet.
- `warp_process_f32_ex` extends the old ABI with trailing `outside`
  mode (0=Kill, 1=Pass). The old `warp_process_f32` remains available and
  defaults to legacy Kill. `warp_map_frequency` accepts mode 0=Fold H,
  1=Blend, 2=Fold L.
- Web auto-update is **asynchronous re-rendering** of the full recording
  on every settled parameter change, then a short aligned crossfade on
  its looping playback. Wet is changed immediately using AudioContext
  gains. This is NOT AudioWorklet streaming / sample-accurate realtime
  DSP and it may be noticeably delayed for longer audio and High quality.
  The full offline Rust core, rather than a separate JS DSP, is still
  used for every update.
