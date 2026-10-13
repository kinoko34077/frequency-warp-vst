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
- 2: time-domain Ring Mod. Zero FFT lookahead, not a warp equivalent.
- 3: pitch ratio plus signed Hz offset via tracked partials. The
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
