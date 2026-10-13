# Offline DSP reference — R0/R1

This directory is for **research only**, not a VST3/audio-thread implementation.

## Setup and run

- Python 3.10+ and NumPy (locally checked with NumPy 2.3.5).
- From the repository root: `python -m unittest discover -s tests -v`.

`reference.py` contains:

- `map_frequency(frequency_hz, low_hz, high_hz, curvature, invert, mode)` for the accepted curvature and experimental `fold` / `blend` invert progressions.
- `linear_direct_transform(audio, sample_rate, shift_hz=...)` and `reflection_sum_hz=...` using a **whole-record FFT analytic signal** reference.
- `mix_wet` for an already sample-aligned offline pair.

## Boundaries and caveats

1. Mapping only accepts frequencies in **[L,H]**, with 0 < L < H. This deliberately does **not** choose the deferred out-of-band policy. Nyquist, DC/negative target modes (Reflect/Kill/Fade), and realtime memory/latency handling are not implemented.
2. `curvature=0` uses logarithmic coordinates (inverse frequency reflection); `curvature=1` uses linear coordinates. Intermediate `invert` with `fold` stays in-band but is generally non-injective and has a turning point. Intermediate `blend` can compress the spectrum; for linear curvature at invert=0.5 the entire interval collapses to one frequency.
3. Whole-record FFT Hilbert is noncausal, assumes periodic boundaries, and can ring near segment ends. It is **not** suitable for streaming realtime audio as written. It provides a controlled mathematical baseline, not a product-ready DSP.
4. The linear conjugation reference **reverses interchannel phase differences** on coherent stereo sine components. It keeps a shared oscillator and preserves their amplitude ratio in a controlled test, but **does not guarantee stereo imaging**. Joint stereo handling needs research in R2/R3.
5. Frequency shifts and reflections are not automatically bandlimited/antialiased; test inputs must keep mapped frequencies strictly between DC and Nyquist.
6. The reference `mix_wet` expects time-aligned arrays; it does not implement host latency reporting/compensation or prevent phase cancellation.
7. Quality tiers (Eco/Standard/High/Maximum are merely examples) remain to be measured/defined; they are **not** implemented by this prototype.
8. Synthetic coherent tones and a central-window chirp check are narrow technical tests, **not** listening tests or guarantees on complex music.

## Next research step

Compare STFT instantaneous-frequency / phase-locking with sinusoidal partial-tracking+residual against a shared corpus (tones, chirps, crossing components, voice, transients, stereo) and report objective/perceptual/CPU/latency tradeoffs before selecting the nonlinear engine.
