# Automated acoustic quality evidence (Issue #299)

**Status:** M1 test-only calibration / source-under-review. These measurements do not certify human preference, identity at arbitrary host sample rates, or realtime CPU deadlines.

## Higher purpose and measurement applicability

Frequency Warp deliberately changes frequencies nonlinearly. A single full-reference waveform comparison of output to *unwarped* source would incorrectly penalize desired transformations; a single trained perceptual score can incorrectly reward silence, clipping, or different pitch. Use a family of independent, explicitly typed oracles:

| Reference class | What is compared | Primary measures | Do not conclude |
|---|---|---|---|
| Exact waveform (transform = identity, no FX) | Source and output with **declared** latency/alignment | NRMSE, RMS gain dB, polarity/correlation, clipping, windowed RMS | Valid nonlinear or creative processing |
| Known partial/frequency trajectory | Phase-integrated mapping oracle or lock-in at documented target | target frequency error, old-frequency ghost, spurs/alias, modulation/phase slip | A source PCM must equal transformed PCM |
| Known temporal envelope | Gate/impulse/onset expected position, declared latency | pre-echo, attack onset displacement, dropout, crest and tail behavior | Perceived musical attack quality from one threshold |
| Stereo with known relationship | M/S power, ILD, IPD, ITD against fixture | side energy, interchannel correlation, level and relative-delay change | General spatial preference without a measured reference |
| Underdetermined complex/noise source | Source statistics and degradation proxies only | residual-band energy, spectral coloration, envelope instability | Unique mathematical “correct sound” for stochastic input |
| Runtime/host | Same exact Rust Stream + WASM + native + Web/DAW | 128-frame underruns/NaN, WAV/live agreement, latency and CPU | iPhone/DAW hardware success from Chrome |

## M1 machine contract and calibration

Reusable test helper: `web-demo/acoustic-quality.mjs`.
- `fullReferenceQuality` rejects silent reference and nonfinite PCM; reports raw amplitude, normalized waveform error, correlation and time-block RMS without independent gain-normalizing away errors.
- `stereoImageQuality` reports ILD (R/L level), L/R correlation and side-vs-mid energy. Stereo collapse is a **hard** adverse control.
- `toneComponentQuality` measures Hann-windowed continuous-Hz target projection and unwanted original-frequency ghost. It is not a general musical pitch estimator and can have leakage; construct separated tones with enough sample duration.
- `qualityGate` returns **separate failures per named axis**, not an invented average or MOS. `baselineNeutralContract` currently uses NRMSE≤0.08, gain 0.93–1.07, correlation≥0.995, no >1.0-sample clips. These are **engineering regression thresholds**, not literature-derived human audibility limits or universal product targets. Calibrate against several objective clean/known-bad controls and, in M3, an external human-rated benchmark.
- The calibration tests inject mute, gain changes, clipping, time shifts, dropout, stereo collapse and wrong-frequency output. Each should be detected under the appropriate task-class oracle; a clean signal should pass.
- Rust-WASM `core-wasm.test.mjs` uses **actual generated PCM from the shared Rust engine**, not source-only or fixture mocks; Engine B is a neutral negative control, Engine A's known peak-only deficit is reported as a **red PRODUCT gate** even if the harness CI passes. Experimental residual quality=100 is measured separately, **not automatically accepted**.

**Issue #48 products:** the existing Engine A neutral reconstruction loses much of in-band broadband residual even for identity mapping. A good Engine B control, or quality=100 reducing NRMSE, does not magically fix Engine A at default. Maintain `#48 F0 identity transparent` and `#5 R2.2 nonneutral residual` as independent owners. Under `#48`, test fully neutral mapping, outside=Pass, ring/crusher/reverb/rational OFF; midstream switching/Wet/latency must not cause clicks, double delay or reordered audio before an identity passthrough is accepted.

## Perceptual proxies: possible, not yet integrated

- ITU-R BS.1387-2 PEAQ estimates specific perceptible *degradation against a comparable reference*, not the goodness of a newly composed pitch remap: https://www.itu.int/rec/R-REC-BS.1387-2-202305-I/en
- Google ViSQOL audio mode (Apache-2.0 implementation) supports objective spectro-temporal reference-based assessment, mainly codec/audio impairment use cases; it explicitly documents out-of-domain failure and source activity bounds: https://github.com/google/visqol
- Production-music tests DAFx-2025 found differing sensitivity to hum/glitches and differences in robustness between PEAQ, PEMO-Q, HAAQI, ViSQOL: https://dafx.de/paper-archive/details/zPYxwsZQRNgBM4XY2Azt4A
- FAD's score depends on reference set/embedding and sample count and is **not a single-clip universal quality score**: https://www.microsoft.com/en-us/research/publication/adapting-frechet-audio-distance-for-generative-music-evaluation/
- In 2025 music-preference benchmark work, many generic embedding metrics were weakly related to actual preference. Model evaluation itself needs calibration and a documented domain of validity: https://gclef-cmu.org/static/pdfs/2025huangaligning.pdf

A human-rated reference dataset can be used to *calibrate/validate a model once*; routine regression need not involve listeners. Do not claim universal “satisfying to human ears” without measured cross-genre/out-of-domain calibration. Never download opaque models or incur provider costs merely by enabling CI.

## Roadmap boundary

**M1** automated deterministic metric axes, adversarial controls, actual Rust-WASM identity/residual baseline (this PR); **M2** separately remediate neutral Engine A under #48 and compare exact pre/post PCM; **M3** add aligned/transformed oracle, transient/spatial/CPU gates and validate optional perceptual predictions against an external rated corpus; **M4** compare candidate DSP methods on the same manifests under #5/#273. All outcomes must record SHA/renderer/rate/channels/latency/fixtures and detailed per-axis verdicts. Do not claim a stage complete because later stage's library is available.
