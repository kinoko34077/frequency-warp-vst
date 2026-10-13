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
