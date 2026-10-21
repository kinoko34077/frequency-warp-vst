# Frequency Warp — VST3 / Web shared DSP research

## Current source / contribution entry — 2026-10-21

**Accepted Web main:** `769727696168fe62d62bd14abce0bb8c94111030` ([PR #289](https://github.com/kinoko34077/frequency-warp-vst/pull/289)). On this exact commit the [Browser/Rust/WASM/Chrome](https://github.com/kinoko34077/frequency-warp-vst/actions/runs/39515770022), [offline reference](https://github.com/kinoko34077/frequency-warp-vst/actions/runs/39515769602) and [Pages build/deploy/live-entry](https://github.com/kinoko34077/frequency-warp-vst/actions/runs/39515769407) checks passed. This does **not** establish real iOS Safari device, FL Studio DAW or unimplemented research model acceptance.

**Before implementing/changing an input or shared capability:** follow [devflow AGENTS.md](https://github.com/kinoko34077/devflow/blob/main/AGENTS.md) and [mandatory source index #734](https://github.com/kinoko34077/devflow/issues/734), then consult this repo's [Capability/API Catalog](docs/CAPABILITY_API_CATALOG.md) and [numeric parameter binding specification](docs/PARAMETER_BINDING_SPEC.md). Reuse an existing owner/export/test; extend the owner or add a thin adapter for a justified variation instead of duplicating parsing, canonical parameter state or UI. The [structural reuse guard](web-demo/capability-reuse-check.mjs) runs in [Web CI](.github/workflows/web-preview-tests.yml); negative tests detect supported duplicate patterns, not every semantic duplicate.

**Independent current owners:** [Web units #79](https://github.com/kinoko34077/frequency-warp-vst/issues/79) has released shared frequency F/H binding, unit icons and five typed-% editors via PRs #287–#289; M2 coordinate/count and M3 remaining legacy state retirement remain OPEN. [Web user/device #183](https://github.com/kinoko34077/frequency-warp-vst/issues/183)/[#276](https://github.com/kinoko34077/frequency-warp-vst/issues/276) remain physically unverified on iPhone; [realtime model integration #273](https://github.com/kinoko34077/frequency-warp-vst/issues/273) is not completed by the former Lab audition; [VST3 #172](https://github.com/kinoko34077/frequency-warp-vst/issues/172) remains a separate native/host acceptance path. Historical dated status notes below preserve release chronology and must not override these owning Issues.

---

## Historical 2026-10-15 Web UI release scope

The source includes responsive graph views (2k/20k/0.001–20Hz theoretical zoom), compact Hz/note/rail unit controls, auxiliary sine gain and bounded live-audio setting validation. PRs [#184](https://github.com/kinoko34077/frequency-warp-vst/pull/184), [#185](https://github.com/kinoko34077/frequency-warp-vst/pull/185) and [#186](https://github.com/kinoko34077/frequency-warp-vst/pull/186) retain implementation/CI history; consult the linked main branch and Pages workflow for live release state. Above 20kHz actual processing is reserved for **possible later oversampling**, not current DSP support. Real failing physical iOS Safari audio-file/codec reproduction remains unverified; staged Chrome tests must not be described as proof on that device. Unit-family migration M2/M3 stays open in #79; native DAW/engine R3C2 remains independently owned by #172.


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
