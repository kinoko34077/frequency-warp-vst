# Frequency Warp — VST3 / Web shared DSP research

A frequency-domain audio-warp research project. The goal is a VST3
audio effect with continuously variable frequency-axis curvature and
invert amount, preserving source stereo and transient cues as far as
the mapping permits.

## Current development status

- **R0/R1:** mapping and direct linear inversion references — merged PR #4.
- **R2.0:** shared deterministic six-case audio research corpus — PR #6.
- **R2.1:** measured nonlinear STFT candidate, limitations recorded — PR #7.
- **Shared engine:** Rust `core/` used both as native ABI and browser WASM.
  Research build in [PR #11](https://github.com/kinoko34077/frequency-warp-vst/pull/11).
- **Browser (live):** [GitHub Pages AudioWorklet audio audition](https://kinoko34077.github.io/frequency-warp-vst/)
  — continuous shared Rust/WASM streaming controls and waveform seek; up to 120 seconds.
- **Real-time research prototype:** Issue #14, PR #15; native and WASM Rust streaming process blocks; optional offline WAV export remains separate.
- **Next research:** R2.2 independently compare sinusoidal partial tracking
  and residual preservation, then stereo/onset/CPU studies under Issue #5.

**Not yet built:** actual VST3 host wrapper, streaming/no-audio-thread-
allocation engine, final DSP quality selection, product release.

## Reference documents

- [Technical requirements and adopted curvature](docs/SPECIFICATION.md)
  and [Issue #3](https://github.com/kinoko34077/frequency-warp-vst/issues/3).
- [Shared Rust DSP architecture](docs/SHARED_DSP_ARCHITECTURE.md)
- [Web preview](web-demo/README.md)
- [R2 evaluation protocol](docs/R2_EVALUATION_PROTOCOL.md)
- [R2.1 candidate limitations](docs/R2_STFT_CANDIDATE.md)
- [Development task #10](https://github.com/kinoko34077/frequency-warp-vst/issues/10)

## Tests

```sh
python -m unittest discover -s tests -v
cargo test --manifest-path core/Cargo.toml
```

See `.github/workflows/web-preview-tests.yml` for native+WASM+Chrome
integration tests.


## 2026-10-13 browser engine comparison (Issue #17)
The live [Pages demo](https://kinoko34077.github.io/frequency-warp-vst/)
now provides a square fixed 20–2000Hz mapping graph, ideal harmonic
equations/virtual fundamental calculator from Issue #16, and four
**actual distinct** Rust/WASM realtime engines: partial oscillator,
STFT bin relocation, ring modulation, and pitch→signed frequency shift.
FFT 1024/2048/4096 and 4×/8× overlap are user-controlled, while WebAudio
render quantum remains 128 samples. Other researched alternatives remain
disabled until independently implemented and measured; R2.2 partial+noise
residual comparison remains open in #5. The browser is a research audition
and cannot yet determine the highest-quality engine.
