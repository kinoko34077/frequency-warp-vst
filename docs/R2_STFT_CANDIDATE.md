# R2.1 Offline STFT / instantaneous-frequency phase-warp candidate

Owner: [#5](https://github.com/kinoko34077/frequency-warp-vst/issues/5).
Parent: #1. Fixed user requirements and mapped curvature: #3.
**State: experimental offline comparison candidate; NOT engine selection or VST3.**

## Method

`research/stft_candidate.py` performs framewise, centered periodic-Hann
STFT analysis. From each detected in-band spectral maximum it estimates
instantaneous frequency by wrapped inter-frame complex phase differences,
tracking the closest previously observed partial where possible. It then
extracts a small positive-frequency spectral neighborhood as a windowed
**analytic partial** (inverse FFT) and modulates it by a frequency-difference
oscillator, using a per-track phase accumulator and approximate local
frequency-slope correction. A single carrier rotates both stereo channels,
rather than independently conjugating their phases.

Output is overlapped with the analysis window and normalized by the
overlap-window-square sum. This avoids the destructive cancellation observed
in naive complex-bin interpolation when the Hann mainlobe crosses adjacent
bins. This technique is deliberately closer to *STFT-identified component
remodulation* than to moving arbitrary independent FFT bins.

This candidate depends on local peak identity, finite windows and analysis
latency. It is NOT a mathematical solution for arbitrary inseparable
polyphony. It is computationally expensive if many peaks are detected.

## Reproduce

```sh
python -m unittest discover -s tests -v
python -m research.evaluate_stft
```

Requires Python 3.10+ and NumPy (the CI workflow uses Python 3.11).
The evaluation produces JSON on all six common R2.0 fixtures with
sample_rate=12kHz, duration=0.5s, band [20,5000]Hz, curvature=.5,
invert=.75 fold, n_fft=1024, hop=128. The JSON includes timing,
frame/peak diagnostics, unaligned normalized RMS error against the known
partial-oracle where one exists, and a correctly null oracle for broadband
noise. **R2.0's oracle expresses a specified source model, not unique
perceptual or spatial truth.** Timings are machine-dependent.

## Narrow local proof points (not acceptance thresholds)

Initial synthetic feasibility checks (Python NumPy 2.3.5, Fs=12kHz,
1024-point STFT, hop=128, 0.5s records, [20,5000]Hz, p=1, invert=1):

- 900Hz steady stereo component maps near 4120Hz; relative L/R phase
  +0.49992 rad vs +0.5 rad fixture, relative amplitude 0.74284
  vs .74286 fixture. Output/input left RMS ratio near 0.996.
- 900→1300Hz smooth chirp reflects to 4120→3720Hz. Central (0.15–0.35s)
  analytical IF error median ≈5.26Hz, 95p ≈12.41Hz. Relative RMS ≈0.886,
  showing a measurable loss and need for improvement.
- Standalone zero-mean broadband noise loses energy (output/input RMS
  ≈0.41 in one local random-seed test). **This is a failure mode** due to
  missing residual reconstruction, not a noise-quality success.
- Pure-tone absolute output phase may deviate from the independent
  oracle by a constant offset (one experiment ≈−0.38 rad) even while
  relative L/R phase is preserved. Track initialization/latency/phase
  preservation therefore need further assessment.

These are local initial technical observations; CI evidence and common
corpus outputs must be used for reproducible repository acceptance.
No blind listening test or full music-domain validation has occurred.

## Explicit unresolved risks

1. Spectral peak collisions, births/deaths, crossings and re-linking
   create ambiguity; this baseline uses proximity, not source identity.
2. Removing unmatched/noisy spectral material changes timbre and reverb
   and is **not** a chosen out-of-band, noise or residual policy.
3. Window transient ringing, pre-onset energy and fixed startup phase
   offsets require analysis. Constant-frequency local modulation plus
   first-order slope is not exact for rapidly varying chirps.
4. Stereo relative complex phase is locally preserved for *tracked
   extracted components*, but physical ITD, moving sources, room tails,
   absolute phase and global image are unvalidated.
5. The algorithm has nominal centered-window lookahead `n_fft/2`
   samples; it is an **offline** processor and no host latency has
   been measured or reported. It does not implement streaming state.
6. The candidate makes no assertion about DC / negative targets /
   Nyquist / processing outside [L,H]. Skipping untracked peaks is
   a limited test behavior, not a product specification.
7. Test code and quality levels must not confuse longer FFT windows
   with universally higher quality. CPU, peak memory and true VST
   host latency remain R2.3 / R3 research items.

## Comparison gate

R2.2 must implement a truly distinct sinusoidal-tracking + residual
candidate, measured against this same corpus and parameters. R2.3 must
add physically meaningful stereo timing, transients and listening cases
before R2.4 can recommend an engine. This R2.1 artifact alone does not
authorize final DSP adoption.
