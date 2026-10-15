## Current source/release distinction (2026-10-15)

Accepted public main at the start of this Web branch: ad34eb1992c67fe4a68057cc6a372c08e8506bc8 (visual editor M1–M5 via PR #181). Web UI PR #184 and stacked PR #185 added the newer graph, parameter units and layout code as **unmerged Draft candidates**, not yet published at that checkpoint. Their exact-head Browser/Rust/WASM and offline workflows passed; this does not prove real iPhone Safari decode of the reported failing user file. These docs describe candidate branch behavior; validate actual deployed main and Actions before claiming publication. >20kHz real processing is deferred as possible future oversampling, not a current Rust/VST3 implementation target. The in-band Web/Rust preflight work is separately tracked at #183, native generic DAW routing at #172.

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
  — continuous shared Rust/WASM streaming controls and waveform seek; up to 600 seconds.
- **Real-time research prototype:** Issue #14, PR #15; native and WASM Rust streaming process blocks; optional offline WAV export remains separate.
- **Next research:** R2.2 independently compare sinusoidal partial tracking
  and residual preservation, then stereo/onset/CPU studies under Issue #5.

**Native VST3 status (2026-10-15):** A real Windows x64 VST3 fixed
Processor/Controller shell now builds and passes Steinberg Validator, using
stable DAW automation IDs and a 4095-frame delayed-Dry output.
A separate `fwengine-runtime/` native WASM interpreter (fuel/resource bounded)
processes interchangeable Identity/Gain `.fwengine` packages. A native
C++/Rust staticlib ABI and non-allocating pointer-swap ownership primitive
have isolated Windows/Linux tests. **These components are NOT connected in the
VST3 audio signal path**: drag/drop, Browse/Reload, live engine switching,
complete RT-safety validation and actual Frequency Warp DSP adaptation remain
open under [Issue #83](https://github.com/kinoko34077/frequency-warp-vst/issues/83).
No installable VST3 artifact is published, and FL Studio/second-DAW testing and
product audio-fidelity acceptance are not complete.

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


## 2026-10-13 expanded audition and controls (Issue #22)
- Browser playback can preview up to **600 seconds**, including click/touch waveform seeking; source file cap remains 75MB. Decoding/memory cost grows with duration; this is NOT independently certified for every iPhone generation.
- Mobile: compact square 20Hz–2kHz frequency plot with an equal-scale *inner plot*, and 3-harmonic miniature panel always visible alongside the graph. Expanded formulas no longer hide the plot; Settings selects detailed count 3/5/7/12/16/24/32.
- Rust engine 2 now **warps first**, then time-domain Ring Mod generates two sidebands. Engine 3 now applies Warp -> pitch-ratio -> signed-Hz shift to tracked in-band partials. Therefore Invert/Curvature influence both effects. Unlike the old samplewise Ring-only mode, current Ring pipeline inherits FFT latency and higher CPU cost.
- A shared Rust post-effect Bit Crusher quantizes sample amplitudes (2–16 bits) and reduces sample update rate by sample hold (1–32 samples), independently toggled and adjustable during playback. WAV export uses the same settings and Rust Stream.
- Browser full-file WAV export still has a **40,000,000-sample safety cap**; long stereo clips may be auditioned but cannot necessarily be exported without memory risk. The UI explains this instead of failing silently.
- **Five DSP algorithm families are not all implemented:** analytic complex-modulated direct linear inversion and whole-file Fourier reposition remain offline research references; STFT tracked peaks and sinusoidal resynthesis exist experimentally; residual reconstruction and high-resolution chirplet/nonuniform analyses remain unimplemented. See docs/SHARED_DSP_ARCHITECTURE.md and #17/#5 for exact authority.
