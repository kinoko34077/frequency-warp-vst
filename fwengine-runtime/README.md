# S3a native sandbox prototype (not VST3 integration yet)

Owning Issue: https://github.com/kinoko34077/frequency-warp-vst/issues/83

Native Rust WASM interpreter based on wasmi 2.0.0; reuses `fwengine-package` ZIP manifest, limits and SHA-256 validation. No WASI/host imports and no start function; per-block execution fuel and manifest-derived memory/resource limits. ABI major, typed exports, latency and non-overlapping linear-memory buffer ranges are checked during preparation. Runtime rejects nonfinite input/output PCM, malformed archives and illegal automation. The same executable demonstrably produces different PCM from the two S1 `.fwengine` fixtures without rebuilding the executable.

**S3a is not real-time safe:** this reference host allocates buffers and uses an interpreter on its caller thread. Do not call it from a VST3 audio callback. S3b still requires native C++/Rust bridge, preallocated audio buffers, safe instance handoff/retirement, latency-compensated failure fallback and crossfade/fault injection. S3c owns native Browse/Drag/Drop/Reload and rollback UI; S4 owns the existing shared Rust spectral DSP adapter. FL Studio/Reaper real host tests are separate. No installer or binary published.
