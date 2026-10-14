# S3a native WASM execution candidate (not yet a VST3 audio engine)

Canonical owner: [#83](https://github.com/kinoko34077/frequency-warp-vst/issues/83)

This crate reuses the accepted native S1 .fwengine ZIP manifest/hash verifier
and executes the same WASM binary in a native Rust Wasmi 2.0 sandbox with:
- No host imports / no start function, eager function compilation.
- Memory limit from manifest and bounded IPC regions/event layout.
- Runtime latency vs manifest check and ABI function type checks.
- Explicit per-call fuel and status/trap/memory growth/PCM finiteness checks.
- Transactional output: failed engine cannot write any partial output buffer.
- Malformed replacement engine is rejected without affecting the old instance.
- Actual Identity versus Gain-half PCM using the existing S1 engine ZIP files
  and sample-offset host ParamID 64 events. No browser/Node runtime required.

Intentionally **not yet implemented**: C ABI bridge into VST3 native shell,
cross-thread prepared instance lifetime, host audio RT timing/allocation
proof, bounded crossfade/rollback with PDC alignment, file selection/
Drop/Browse/Reload GUI and DAW project engine-id/sha/bindings restoration.
Do NOT call S3 complete, or call this crate real-time safe, until S3b/c
testing establishes callback worst-case latency and no allocation.

Run:
    cargo test --manifest-path fwengine-runtime/Cargo.toml
    cargo run --release --manifest-path fwengine-runtime/Cargo.toml --bin fwengine-runtime-smoke -- identity.fwengine gain.fwengine
