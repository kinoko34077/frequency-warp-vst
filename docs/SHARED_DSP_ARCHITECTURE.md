# Shared DSP Architecture — Current Canon

The same Rust core is built as native staticlib/C ABI and wasm32/WASM.
Web is only an audio host and UI. Future VST3 must consume the same
streaming interface (the native VST3 wrapper is not yet implemented).

## Ownership and duplication audit (#19)

| Concern | Single source | Usage |
|---|---|---|
| Curvature / Fold / Blend spectral mapping | core/src/lib.rs: map_frequency and warp_map_frequency | Rust DSP, browser graph via WASM |
| Fold input breakpoint | core/src/lib.rs: fold_frequency and warp_fold_frequency | Native Rust Ring coupling and Web readout via WASM |
| Streaming audio engines | core/src/stream.rs: Stream::process | AudioWorklet on WASM; native C ABI |
| WAV file export | core/src/stream.rs: warp_stream_render_f32_ext | Same Stream::process, offline host with latency compensation |
| Web audio transport, Dry/Wet | web-demo/app.mjs and realtime.worklet.js | Web host adapter only |
| Ideal harmonic F,m,n,q equations | web-demo/harmonics.mjs | Numeric *theoretical model*, not acoustic DSP |
| Mathematical independent reference | web-demo/mapping-oracle.test-helper.mjs | Test-only, not shipped to Pages |

Production browser code does NOT independently implement nonlinear
frequency mapping. It uses the SAME compiled WASM warp_map_frequency
export that the Rust streaming DSP uses. An independent test oracle is
valuable for detecting shared implementation errors but must never be
used as a second production algorithm.

## User-controlled Ring carrier link

Fold is defined in normalized S_p coordinates, where D=S_p(H).
The **input-side direction change point** is:
- Fold H: f_fold = S_p^-1((1-a)D)
- Fold L: f_fold = S_p^-1(a D)
- Blend: has no direction-change point.

With linked-carrier enabled and a Fold mode, Web sends carrierHz=-1.0.
Rust resolves it inside the streaming DSP from the *same mapping* every
audio block. When Blend is selected while link remains checked, the
UI explicitly indicates the manual carrier is temporarily used. This
carrier is separate from theoretical virtual fundamental H_virtual=F/m
in Issue #16. Ring Mod creates both f+c and abs(f-c) sidebands; it is
not a nonlinear inversion.

## Engines and current limitations

- 0: STFT peak-following / oscillator resynthesis. Tonal partials only;
  noise/residual handling incomplete.
- 1: FFT-bin reassignment / inverse FFT. Quantization and phase artifacts.
- 2: tracked STFT nonlinear Warp **then** time-domain Ring Mod. This preserves\n  Invert/Curvature, creates two sidebands and inherits the FFT N−1 lookahead.\n  An independent instantaneous Ring-only path is not selected by this engine.
- 3: tracked STFT nonlinear Warp **then** pitch ratio plus signed Hz offset\n  for tracked in-band partials. The
  parameter F is entered manually, not auto-detected.
- Unimplemented research paths (analytic linear invert, partial+noise
  residual R2.2, chirplet/nonuniform analysis) remain disabled in UI.

For streaming engines using STFT, quality FFT size is 1024/2048/4096;
hop=N/4 or N/8. Algorithmic latency is N-1 samples (not hardware
latency). WebAudio calls AudioWorklet with 128-sample quanta; this
quantum is not user-adjustable. Engine/FFT/hop changes cause a short
state rebuild and retain approximate playback position. Other knobs
update live without rendering the full recording.

The zero-frequency Fade path was fixed during #19 audit: previously
it returned 0Hz, then immediately skipped that component (identical
to Kill); it now applies a bounded experimental gain curve near the
negative-frequency boundary. Its actual audio quality remains unproven.

WAV export uses the same streaming Rust engine as live playback, but
whole-file processing may take substantial time. The export adapter
discards algorithmic lead-in silence and flushes tail samples. Separate
legacy R2.1 offline references remain for research and regression only.

## UI ownership and source-based UX criteria

Source: '利用者起点 UI/UX 設計原則' (user-provided Project Source,
586 lines read) UX-01/04/05/06/08/09/11/14/15.
High-frequency transport and Invert/Curvature/Wet/L/H are on the main
workstation beside the graph. Engine, Fold style, outside policy,
FFT/hop and zero-target settings are in an accessible modal. The
harmonic laboratory is a nearby tab with paired range/numeric controls;
toggle and return do not reset playback. On mobile, a single-column
layout replaces forced desktop miniaturization.

Chrome smoke and automated Rust/WASM tests establish feature
functionality. Human subjective usability, perceptual DSP preference,
and real iPhone audio performance remain UNVERIFIED pending actual
device/user testing. Do not claim 'small-child usability certified'
without a test.

## Proof and dependencies

CI: native cargo tests, shared Rust wasm32 compile, Node oracle and
real PCM output checks, Chrome 12-second playback/control/seek and
responsive mobile viewport. Pages only publishes app/graph/harmonics
UI, processor Worker/Worklet and Rust-built dsp_core.wasm.

History: PRs #11, #13, #15, #18; current UX/common refactor PR #20
(Issue #19). Research Issue #5 and incomplete candidate Issue #17
remain separate and are not automatically accepted by this UX change.

## 2026-10-13 UI extension and five candidate families (Issue #22)

Browser audition cap: 600 seconds (previously 120), source file size cap
75MB. Decoded PCM can require hundreds of MB at 48 kHz stereo;
full-buffer WAV export remains capped to 40,000,000 samples as a memory
safety bound. This means a long high-rate stereo file can be previewed
but its WAV may not be exportable from the browser; never present this
as successful 600-second export.

The mobile graph is capped to 255 CSS pixels, and its **inner frequency
plot** is mathematically square with equal Hz-to-pixel scale on x/y.
A 3-harmonic compact card is always visible immediately below the
graph. Expandable detail retains the graph in view; 3/5/7/12/16/24/32
harmonic count is controlled in Settings. Harmonic formulas remain an
ideal manual-F theoretical model, not detected notes.

A shared Rust DSP post-effect applies Bit Crusher quantization (2–16
bit) and optional sample-and-hold rate reduction (1–32 input samples)
to ANY selected engine. It is live-configurable via
warp_stream_set_crusher, and uses the same setting when exporting WAV
via warp_stream_render_f32_fx_ext; both preserve Rust native/WASM parity.
Bitcrusher alters time-domain sample resolution/hold; graph remains a
frequency-axis *ideal map* and does not draw broadband quantization noise.

### Five proposed implementation categories — factual status

| User candidate | Actual current implementation status | Boundary |
|---|---|---|
| Analytic signal + complex modulation (constant Hz shift, direct linear inversion) | **Offline R0/R1 reference only** (PR #4). NOT live Web Rust analytic conjugate engine | Has mathematically clean constant shift / linear conjugate path under analytic-band and Nyquist constraints, not general nonlinear mapping |
| STFT + phase tracking | **Experimental implemented** (R2.1 offline Python, Rust streaming peak phase estimates) | Measured transient/phase/noise defects; not quality-approved |
| Sinusoidal partial tracking + resynthesis | **Experimental implemented in part** (current Rust peak tracking and oscillator reconstruction) | Does NOT include phase-perfect tracking, noise/residual reconstruction (Issue #5 R2.2 pending) |
| High-resolution time-frequency (chirplet/reassignment/nonuniform) | **NOT implemented** | Research candidate only; arbitrary increased FFT window is not a distinct verified high-resolution analysis architecture |
| Whole-file Fourier transform + frequency relocation | **Offline reference/baseline only** and experimental *framewise* FFT-bin relocation | Current live FFT-bin engine is STFT window-by-window, NOT whole-file Fourier transform; whole-file method is not a selectable live engine |

These are research algorithm **families**, not equivalent to four UI
effect modes. Ring modulation and pitch+frequency shift are effects
that transform component frequencies differently, not replacements for
the five algorithm research paths. No fidelity/CPU winner established.

Current known quantitative unresolved: long-file memory on physical
iPhone; subjective sound of warp→Ring and pitch, crusher aliasing; FFT
CPU budget on iPhone. User informally reported that previous iPhone
version seemed to work; this does NOT verify 600-second worst-case
memory and DSP cost across devices.
