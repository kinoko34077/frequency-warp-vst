# Frequency Warp VST — initial scope

## Objective
Develop a VST3 audio effect that explores spectral frequency transformations beyond conventional constant-Hz frequency shifting.

## Proposed transformations (research targets)
- Constant-Hz translation: f' = f + Δf.
- Frequency inversion around a configurable reference, including f' = C/f for f > 0.
- Continuous parameterized mappings between linear and logarithmic-style behavior, subject to mathematical and DSP feasibility.
- Sample-rate-aware handling of frequency ranges, DC and Nyquist boundaries.

## Engineering boundaries
- Separate mathematical frequency mapping from the DSP implementation.
- Evaluate latency, phase continuity, aliasing, artifacts, CPU usage and automation before selecting a DSP algorithm.
- Target VST3; framework, OS support, UI and distribution remain undecided.
- No claim that an ordinary frequency shifter alone implements arbitrary nonlinear spectral mapping.

## Initial milestones
1. Define exact transformations, control parameters and edge behavior.
2. Prototype offline DSP and objective audio tests.
3. Select a realtime-capable architecture.
4. Build and test VST3 prototype.

This is an initial research scope, not an approved complete product specification.


## 2026-10-13 accepted Web preview controls (user instruction; Issue #12)
- Adjustable logarithmic `L` and `H` controls, applied to actual shared Rust DSP and the Web plot.
- Out-of-band input policy: **Pass or Kill** (complementary STFT-bin preservation vs removal); distinct from the existing target-0Hz Reflect/Kill/Fade modes, which are not implemented yet.
- Invert progression: **Blend / Fold at L / Fold at H**; at invert 0 identity and at 1 all modes same full inversion.
- Web knob changes during preview are applied by background Rust/WASM offline re-render and playhead-synchronized brief crossfade while old audio keeps playing. Wet uses WebAudio gain automation without rerender. This does **not** imply sample-accurate realtime DSP or that VST3 itself already exists.
- Web trial remains up to 120s; no final DSP sound-quality selection has been made. See `docs/SHARED_DSP_ARCHITECTURE.md` and [Issue #3](https://github.com/kinoko34077/frequency-warp-vst/issues/3).


## 2026-10-13 true realtime Web preview + waveform seek (Issue #14)
The user clarified that effect-style controls must apply during **realtime audio
rendering**, **not** trigger an offline whole-recording re-render. The previous
full-file Worker/crossfade interface in #12 is superseded for audition.

- Shared Rust core added a persistent streaming ABI
  \`warp_stream_create/set/process/reset/latency/free\`, compiled to both native
  and WASM. The \`core/src/stream.rs\` algorithm incrementally processes STFT
  peaks with buffered overlap-add and input-band Pass/Kill on 128-frame WebAudio
  render quanta; no entire-track processing is required for preview.
- AudioWorklet hosts the WASM state and accepts L/H, Curvature, Invert, three
  Invert progression modes and Outside Pass/Kill parameter updates. Wet uses
  WebAudio gain adjustment. A Quality/FFT-size change requires stream rebuild.
- Waveform click/tap seeks and starts playback from the indicated position;
  keyboard supports Enter/Space and ±2-second arrows. State reset prevents
  spectral history leaking between unrelated positions. Playhead/time displayed.
- Separate offline full-buffer processing is retained **only for WAV export**.
- This is an experimental new *streaming resynthesis* method, not acoustically
  identical to R2.1 offline and not an installed VST3. Finite lookahead:
  N−1 samples (Eco 1023, Standard 2047, High 4095); actual output latency adds
  device/buffer overhead. Sound fidelity, CPU performance on mobile and streaming
  peak tracking remain empirical research questions.


## 2026-10-13 comparator UI request (Issue #17, PR #18)
- Graph window fixed at **20–2000 Hz** on x and y, rendered as a
  square. The highlighting only applies on [L,H] (may extend beyond
  display), the outside Pass curve follows f'=f and Kill omits outside
  mapping. Display clipping to 2000 Hz is **not a DSP cutoff**.
- Numerical math explorer follows *research minutes* Issue #16:
  ideal harmonic F (manually supplied), H=F/m, delta=(n/m)F,
  f'_k=(mk+n)H, downfold |kF−S|, S=(q+1/m)F, ring sidebands
  f+c / |f−c| and pitch-first r·f+delta. This is analytical preview,
  **not a claimed fundamental/chord estimator or an automatic audible root**.
- Web settings select tested actual native/WASM streaming DSP branches:
  tracked peak oscillators, bin-relocation STFT, time-domain Ring Mod,
  pitch-first signed-Hz shift. These are **not four interchangeable
  implementations of the same mathematical nonlinear warp**: Ring Mod
  creates upper/lower sidebands; pitch+Hz uses a different mapping.
  Separate their intent when comparing musical outcomes.
- Candidate implementations with no validated engine (direct analytic
  linear inversion, partial+residual R2.2, chirplet/nonuniform analysis)
  appear **disabled**. A complete scientific ranking remains unmet.
- Buffer controls: FFT windows 1024/2048/4096, hop N/4 or N/8. Browser
  render quantum 128 frames cannot be changed through this control.
  Higher overlap can increase CPU, larger FFT increases N−1 delay;
  Ring Mod bypasses this FFT processing.
- Source: Issue #17 and shared DSP architecture. Chrome/native/WASM
  test evidence is attached to PR #18 and deployment actions.


## 2026-10-13 user-requested live long-preview/analysis update (Issue #22)

- Web audition duration maximum **600 seconds**; source file maximum remains 75MB. This changes Web preview only, not the native VST3 status. WAV export remains bounded to 40 million total decoded samples because full-buffer WASM rendering would risk exhausting iPhone/browser memory for long stereo high-sample-rate files. State the failure explicitly in the Web UI.
- Graph display remains fixed at [20,2000] Hz on both axes but the **inner plotting rectangle must also be square** (equal pixel/Hz scale). Mobile display should be compact, not fill the screen width.
- Show theoretical virtual H=F/m and up to 3 harmonic entries always with the plot. Detailed lab toggles in place and does not replace the graph. Settings controls 3/5/7/12/16/24/32 rows.
- Engine 2 now follows nonlinear shared Rust frequency warp g(f) (Invert/Curvature/L/H) **before** Ring Mod. Its output has the ideal two sidebands at g(f)+c and |g(f)-c|, with the FFT latency/CPU of that nonlinear preprocessor. Engine 3 now applies pitch ratio r and constant offset Δ to the warped partial frequency: f'=r*g(f)+Δ for selected in-band partials. Outside-band Pass reconstruction stays unshifted for Engine 3; when Ring is a post-modulator it affects the total pre-warp output including passed material. This is an explicit difference; Ring is not the same operation as single-sideband shifting.
- Bit Crusher is an independently toggled shared Rust **post** effect, not another proposed spectral algorithm. Controls: 2–16 quantization bits, 1–32 sample hold. WebAudio Worklet and WAV Rust stream export must process the same FX settings.
- Research methods inventory: the five user-named methods are NOT all production/live implementations. Direct analytic/complex modulation and whole-file FFT reposition have offline research scope; STFT phase analysis and sinusoidal partial tracking are experimental/incomplete; advanced chirplet/nonuniform/high-resolution methods not implemented. Pending work remains #17/#5; do not silently mark those candidates complete.
