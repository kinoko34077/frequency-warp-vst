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

## 2026-10-13 realtime streaming DSP / AudioWorklet (Issue #14)

The shared Rust library now implements **two intentionally distinct
processing interfaces**, not two separately maintained languages:

- \`core/src/lib.rs\` / \`warp_process_f32_ex\`: original offline R2.1
  reference-style analysis, used only when exporting the full WAV.
- \`core/src/stream.rs\` / \`warp_stream_create/set/process/reset/free/latency\`:
  persistent bounded state, overlap-add STFT and peak-linked sinusoidal
  resynthesis, with out-of-band spectral complement. The native build
  exports the same C ABI consumed in browser by WASM. This is the base
  for a future VST3 host adapter; **no VST3 plugin exists yet**.

The two methods share Rust types/mapping/FFT definitions, while the
realtime oscillator resynthesis trades some fidelity for lower work per
block. This is an explicit algorithmic difference, not an additional
JS implementation or a claim of numerical equivalence.

### Live streaming lifecycle

AudioBufferSourceNode -> AudioWorkletNode (one input, two outputs).
The processor calls \`warp_stream_process\` for every 128-frame input,
with fixed-size preallocated WASM buffers/rings. Wet samples go to a
WebAudio gain; the dry output is lookahead-aligned (N−1 samples).
WebAudio performs the final Wet/Dry mix. Parameter messages update
\`warp_stream_set\` in the persistent state at the next Worklet message
boundary; no processing of the full recording is required. For FFT size
changes, the stream is recreated to adjust its latency. Starting playback
compiles/instantiates the WASM binary once; previously compiled bytes
are cached on the main thread for subsequent playbacks.

A waveform pointer tap/click converts the pointer's x position into a
sample time. The playback source restarts at that offset and resets the
Rust stream so previous STFT state does not leak across the jump. Source
playhead and elapsed display update continuously. Keyboard operation
supports Enter/Space and ±2s arrows.

### Constraints / measured boundaries

FFT latency is **N−1 samples**: Eco FFT1024 -> 1023 samples, Standard
FFT2048 -> 2047, High FFT4096 -> 4095. This is distinct from the hardware
output latency. WASM/AudioWorklet Chrome CI establishes *functional*
real-time processing without full-file rendering and input seek. It does
not establish glitch-free guaranteed scheduling on every mobile device;
block CPU/over-budget diagnostics are exposed when supported.

Web audition is immediate on the normal device buffer timeline aside
from initial WebAudio/WASM setup and FFT warm-up. This does not make the
optional offline WAV export instantaneous; that still processes the
whole selected audio file.

Status and evidence: [Issue #14](https://github.com/kinoko34077/frequency-warp-vst/issues/14).


## 2026-10-13 multiple engine research controls (Issue #17)

Live Web configuration exposes **actual different Rust streaming engines**, not
aliases: \`core/src/stream.rs\` selects its processing branch at stream creation
via \`warp_stream_create_ext\` (retaining \`warp_stream_create\` compatibility).

| ID | Implemented mechanism | Potential quality/CPU tradeoff |
| --- | --- | --- |
| 0 | STFT tracked prominent peaks -> continuous-ish oscillator resynthesis | Peak count bounds CPU; residual/noise missing |
| 1 | STFT FFT-bin relocation with inverse FFT | Bin-grid quantization, coarse phase, lower analysis overhead but still FFT-heavy |
| 2 | Time-domain Ring Mod, \`x(t)*cos(2πct)\` | True no-FFT sample processing; **not the same spectral warp**, adds two sidebands |
| 3 | STFT tracked peaks with pitch-ratio and constant-Hz signed shift | Ideal \`r*f+(n/m)F\` approximation to Issue #16; noise and inharmonicities untracked |

Mode 3 accepts explicit user-provided \`F,m,n,r\`; NO automatic fundamental
inference. Negative target frequency has experimental Reflect/Kill/Fade options
(phase/energy and transition effects remain unvalidated), separate from the
L/H-progress Fold mode.

Comparison candidates from specs #3/#5 that **are not implemented** are visible
as disabled options: direct analytic conjugate linear inversion, sinusoidal
partial tracking **plus residual reconstruction**, and nonuniform/chirplet
analysis. The existing oscillator model does not claim to provide residual
reconstruction merely because it tracks partials. No ranking of acoustic
quality is inferred from option presence.

The host can select FFT 1024/2048/4096 samples and 4× or 8× overlap:
hop = FFT length / overlap. AudioWorklet render quantum **always remains 128
frames**, not configurable via the UI. Increasing overlap roughly doubles
frame processing frequency, potentially increasing CPU demand. Ring mode
bypasses FFT entirely and reports 0 FFT lookahead; other engines report
FFT_N−1 sample algorithmic delay before hardware output latency. The interface
shows an approximate DSP callback time and number of over-budget blocks
instead of claiming real-time quality for unsupported devices.

Visualization plots the **full 20–2000Hz input/output coordinate** in a
square. The [L,H] range is highlighted; outside Pass draws identity and Kill
omits the trace. Ring mode instead draws two sidebands and is not equivalent
to the nonlinear warp. Values outside the graph's 20–2000 range are clipped
**for display only**, not removed by the sound engine. Formula explorer
reproduces Issue #16's \`H=F/m\`, \`Δ=(n/m)F\`, \`(mk+n)H\`, \`S=qF+H\`,
\`|kF−S|\`, and Ring Mod sum/difference branches as an ideal numerical model.
