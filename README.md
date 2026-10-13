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
- **Browser:** [GitHub Pages audio audition](https://kinoko34077.github.io/frequency-warp-vst/)
  (available **after successful Pages deployment**); up to 120 seconds.
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
