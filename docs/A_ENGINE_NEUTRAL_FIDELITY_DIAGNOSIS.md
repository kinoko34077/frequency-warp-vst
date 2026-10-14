# Engine A: identity-map spectral loss and user-reported "ショワショワ"

Evidence owner: [Issue #48](https://github.com/kinoko34077/frequency-warp-vst/issues/48). Linked, **independently incomplete** research: [R2.2 #5](https://github.com/kinoko34077/frequency-warp-vst/issues/5), web candidate [#17](https://github.com/kinoko34077/frequency-warp-vst/issues/17). Evaluated main base `c6d8db40846027c8ff49448e09c2b323493e738c` (2026-10-14).

## Observation vs. direct proof

The user reports strong artificial, noise-cancelled or watery texture when manually selecting Engine A despite zero transform. The auditory description is a user observation; no upload or iPhone capture is available.

**Source-confirmed nonidentity**: in `core/src/stream.rs::Stream::process_frame`, A (engine 0) always collects local FFT maxima and reconstructs a bounded set of continuous oscillators, even when `map_frequency(f) == f`, `axisShift == 0`, `axisSlope == 1`, all extra effects OFF. Only audio outside `[L,H]` is preserved by the separately synthesized FFT `complement`. No residual reconstruction exists *inside* `[L,H]`. The transform mapping being mathematically neutral does not make this resynthesis an identity operator.

`core/src/lib.rs::quality` caps tracked peaks per frame:

| FFT N | Selected peaks, maximum | Magnitude threshold vs strongest frame peak |
|---:|---:|---:|
| 1024 | 6 | 9.0% |
| 2048 | 10 | 4.5% |
| 4096 | 18 | 2.5% |

`a_peak_band_bins`=1–8 changes how close spectral maxima must be to qualify; it does **not** reconstruct the rejected noise/residual. Reverb amounts are an additional post-effect, not reconstruction.

## Direct numerical results from actual Rust/WASM audio output

[CI #38525008053](https://github.com/kinoko34077/frequency-warp-vst/actions/runs/38525008053) ran the new `core-wasm.test.mjs` diagnostic through `warp_stream_render_f32_a_band_ext`. **PASS means the measurement ran successfully, not that fidelity is acceptable.** All values below are deterministic synthetic mono, Fs=12 kHz; L=20,H=5500 Hz; Invert=0, Blend, curvature=1, shift=0, slope=1, pivot=350, Wet=100%, outside Pass, Ring/Rational/Crusher/A-reverb OFF, N=1024 unless noted. One-second PCM compared over frames [4200,10000] after native offline latency compensation.

| Source | A RMS gain | A waveform normalized RMSE | A correlation | B RMS gain | B normalized RMSE | B correlation |
|---|---:|---:|---:|---:|---:|---:|
| 440 Hz tone | 0.87430 | 0.12570 | 1.00000 | 1.00000 | 0.00000 | 1.00000 |
| Broadband noise | 0.37402 | 0.88242 | 0.48290 | 0.99864 | 0.02967 | 0.99956 |
| 440 Hz + noise | 0.82772 | 0.34967 | 0.94407 | 0.99985 | 0.01025 | 0.99995 |
| Gated 880 Hz bursts | 0.35692 | 0.87981 | 0.49496 | 1.00000 | 0.00173 | 1.00000 |

For broadband noise, A's RMS ratio 0.37402 implies only ~14.0% of input *power* survives at this stimulus scale. Output RMS temporal coefficient of variation was 0.05718 (A) vs 0.02359 (B), indicating more temporal level fluctuations, but not independently proving the perceived musical-noise character.

| FFT N | A broadband-noise RMS gain (bins 1) | A normalized RMSE | B RMS gain |
|---:|---:|---:|---:|
| 1024 | 0.37402 | 0.88242 | 0.99864 |
| 2048 | 0.36326 | 0.89209 | 0.99923 |
| 4096 | 0.35658 | 0.89723 | 0.99959 |

A-band peak neighborhood set to 8 instead of 1: output broadband-noise RMS gain 0.37269 / 0.36394 / 0.35817, respectively. **Increasing neighborhood to 8 or using higher FFT N does not recover the lost broadband content.** A single pure tone remains highly correlated but its amplitude in this fixture is reduced; this is distinct from noise's structural non-reconstruction.

These numbers describe specific deterministic artificial signals and the native offline wrapper using the *same persistent* Rust Stream as live. They do not reproduce or numerically certify the user's actual recording or iOS device perception. The earlier separate Python R2.1 wideband-noise gain 0.44797 (Issue #5) is context, **not** substituted for these direct A measurements.

## Causal model and degree of support

1. **Root, confirmed**: in-band peak-only synthesis drops broadband/noisy/transient residual even for `g(f)=f`. Sparse per-window partials replace natural sound textures. This alone explains the noise-cancelled texture.
2. **Secondary, structurally plausible**: strongest-peak limits, amplitude floor, local-max tie-breaking, instantaneous-frequency peak tracking and single-nearest-track phase matching can change selected peaks across frames. This may cause watery/chirping modulation, but **the specific relative phase contribution is not yet isolated**.
3. **Not a likely root here**: 0-Hz Reflect, nonlinear Fold, user transform mapping or browser file-loading layer, because the failure is replicated in direct Rust/WASM with neutral transform and all auxiliary FX disabled. B's near-identity result is a useful negative control. Offline Rust already compensates n−1 stream lookahead and must not be double delayed.

## Engineering decision candidates (not implemented by this diagnostic)

**A. Neutral-operation transparency guard (immediate defect remedy).** Under strictly neutral mapping and no enabled auxiliary effect or intentional outside-band Kill, bypass peak selection and pass original samples through a latency-matched dry path. Verify exact or near-exact waveforms, startup/tail behavior, mid-Wet alignment, toggles, and no stream/transport discontinuity. Preserve deliberate A coloration only through an explicit separate option if required. This makes `invert=0` mean *no tonal alteration*, without pretending to solve transformed-A quality.

**B. Spectral residual restoration when mapping is active (fundamental improvement).** Under owner #5 R2.2, estimate peaks + *residual* rather than treating excluded spectral energy as zero, and reconstruct noise/transients with appropriate phase / stereo consistency. Naïvely mixing unprocessed Dry as residual risks double-counting peaks and undoing intended nonlinear mapping; the residual must be separated and recombined with appropriate spectral identity, window normalization and time alignment.

**C. Phase/track stabilization after residual is handled.** Test peak matching hysteresis, phase trajectory continuity, transient onset handling and L/R preservation with the same fixed stimuli. Merely raising the number of peaks, widening peak neighborhood, or adding A-only reverb is not a substitute for residual reconstruction.

## Acceptance boundaries for future implementation

- True neutral A with all other effects off: almost sample-transparent (identity waveform normalized RMSE approaching 0 and RMS ratio/correlation approaching 1; target tolerances must be set per tested audio path). Apply to noise, pure tone, mixed harmonics, impulses/transients and stereo, not only isolated sine.
- A with actual nonlinear warp: measure retained residual/noise spectral energy, phase/stereo cues, attacks and musical-noise flicker against B and a nontrivial oracle; preserve CPU/memory limits and A/B distinct algorithms.
- An observed quality improvement is not proven by `node --test` PASS; numerical targets and real-device perceptual testing require separate evidence.
