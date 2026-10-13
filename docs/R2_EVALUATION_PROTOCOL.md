# R2 Nonlinear DSP Comparison Protocol (research plan)

**Owner:** #5. **Parents:** #1 and accepted mapping specification #3. **Baseline:** PR #4 R0/R1 reference.
**State:** candidate evaluation protocol, not an accepted DSP-engine implementation.

## Controlled conditions

- Compare on the **same generated sample buffers**, sample rates, mapping parameters, and clock.
- R2.0 synthetic manifest lives in `research/fixtures.py`. It exposes a mixture, known per-partial input frequency trajectories, and one **model-derived** output oracle, if the components are individually defined.
- For deterministic partial cases, the oracle integrates each known partial's mapped instantaneous frequency and carries that partial's amplitude envelope and per-channel level/phase offsets. This **does not** establish a unique ideal warp for general audio or correct psychoacoustic spatial perception.
- Broadband noise intentionally has **no** oracle. It must be scored separately (residual behavior, harshness, spectral instability), and never assigned an arbitrary ground-truth target.
- The current stereo fixtures model **constant interchannel phase offsets**, not physical interchannel time delays. Add separate explicit ITD, room/reverb, correlated stereo and moving-source fixtures before any spatial-quality acceptance.
- The current corpus only supplies input components within [L,H]. DC, target <=0, Nyquist/alias, and outside-band handling remain open product boundaries rather than auto-filled DSP defaults.

## Parameter matrix

- Curvature `p = 0, 0.5, 1`.
- Invert `a = 0, .25, .5, .75, 1`.
- Both `fold` and `blend` intermediate definitions under comparison; `fold` is a priority candidate but **not accepted** as the product mapping until assessed.
- Sample rate `48 kHz` first; subsequent `44.1 / 96 kHz` and relevant buffer lengths.
- Hold test-band bounds and target Nyquist feasibility fixed for each comparison. Do not silently clip/remap a failing candidate into a different test.

## Required variants and measurements

| Signal class | Primary questions | Measurement candidates |
| --- | --- | --- |
| isolated tone | exact target frequency/amplitude/phase | output IF error, spur power, normalized amplitude error |
| monophonic glide | continuity through FFT/peak bins and fold apex | IF trajectory RMSE/95p, derivative discontinuities, dropout count |
| crossing chirps | component assignment and multi-to-one collision | partial identity swaps, local residual/artifact energy |
| harmonic stack | source-relative phase/coherence and collisions | spectral peak error, phase residual, unexpected sidebands |
| gated burst | onset blur, precursor energy and tail preservation | onset displacement, pre-onset energy, envelope correlation |
| broadband stereo noise | stability of residual path, imaging | channel correlation, energy difference, residual coloration |
| linked stereo spatial cases (future fixture) | ILD, IPD, ITD | measured L/R ratio, phase difference, group-delay discrepancy |

Reference comparisons must report **with and without** timing alignment when alignment is meaningful; hiding latency by free resynchronization must not be described as preserving onset timing. Do not normalize amplitudes independently between algorithms to conceal gain errors.

## Candidate paths (no adoption yet)

1. A: STFT instantaneous-frequency and phase-continuous peak/phase-locked warping with overlap-add reconstruction. Record FFT/hop/window, onset behavior and synthesis-phase initialization. Merely reassigning magnitude bins is not an acceptable proof.
2. B: joint-channel sinusoidal partial tracking, phase integration and residual/noise reconstruction. Record track birth/death and crossing policies, unmatched-energy loss, timing and stereo phase management.
3. Reassignment/chirplet/synchrosqueezing only if a documented deficiency of A/B justifies greater complexity.

## Output and acceptance artifacts

For each test, record code SHA, platform, sample rate, buffer duration, algorithm/window/hop/tracker settings, numerical mapping/parameters, reference availability, metrics, CPU time (real-time factor), peak memory estimate, algorithmic and host-facing latency; include failing audio cases, not only averages.

R2.1/R2.2 must produce real audio transforms and common measurable results before any engine-selection conclusion. Quality tiers and a VST3 integration plan follow measured constraints, not guessed FFT size labels.
