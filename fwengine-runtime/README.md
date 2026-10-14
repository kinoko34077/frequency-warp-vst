# S3a native sandbox prototype (not VST3 integration yet)

Owning Issue: https://github.com/kinoko34077/frequency-warp-vst/issues/83

Native Rust WASM interpreter based on wasmi 2.0.0; reuses `fwengine-package` ZIP manifest, limits and SHA-256 validation. No WASI/host imports and no start function; per-block execution fuel and manifest-derived memory/resource limits. ABI major, typed exports, latency and non-overlapping linear-memory buffer ranges are checked during preparation. Runtime rejects nonfinite input/output PCM, malformed archives and illegal automation. The same executable demonstrably produces different PCM from the two S1 `.fwengine` fixtures without rebuilding the executable.

**S3a is not real-time safe:** this reference host allocates buffers and uses an interpreter on its caller thread. Do not call it from a VST3 audio callback. S3b still requires native C++/Rust bridge, preallocated audio buffers, safe instance handoff/retirement, latency-compensated failure fallback and crossfade/fault injection. S3c owns native Browse/Drag/Drop/Reload and rollback UI; S4 owns the existing shared Rust spectral DSP adapter. FL Studio/Reaper real host tests are separate. No installer or binary published.

## S3b0 native C ABI (non-RT bridge only)

[Owning Issue #89](https://github.com/kinoko34077/frequency-warp-vst/issues/89). This adds a cross-platform Rust `staticlib` and a versioned `fw_native_*_v1` ABI whose exact C declarations are in `vst3/src/engine_bridge_abi.h`. Consumers pass the complete verified single-file `.fwengine` *bytes* (not DLL names or paths) on a non-RT worker, receive an opaque prepared WASM handle, read validated nominal latency, run **diagnostic** planar PCM processing and release it from the same worker. All C exports catch Rust unwinding and return null/error on package/ABI/trap failures.

The FFI processing method currently allocates a `Vec<f32>` and uses the wasmi interpreter, so it is NOT safe to call from a DAW audio callback. Windows VST3 only compiles the header and event layout test: it does **not** link or call the C ABI in its Processor. The next S3b1 worker path must implement preallocated nonblocking audio mailboxes, lifetime-safe prepared-engine handoff, fixed-4095-sample latency alignment, no heap/locks/system calls in `IAudioProcessor::process`, fault fallback and CPU/fuel test. S3c UI file Drop/Browse/Reload and hot swap, S4 shared core and S5 DAW test remain open.

Native Linux/Windows CI builds staticlib and runs the same unchanged S3a host fixtures through the C ABI: Identity input .8->.8, Gain half .8->.4, sample offset 128 automation .4->.2, zero-frame parameter flush and invalid package refusal. These are native executor tests, **not** FL Studio plugin tests. No installer or VST3 binary release follows from this milestone.
