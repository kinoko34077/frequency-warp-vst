# S3b2 — Real-time prepared engine handoff, not a live DSP pipeline

Owning [Issue #93](https://github.com/kinoko34077/frequency-warp-vst/issues/93) · parent [#83](https://github.com/kinoko34077/frequency-warp-vst/issues/83)

`src/rt_engine_handoff.h` is a dependency-free, header-only block-boundary switcher that **only transports opaque, already prepared engine pointers**. It does not read files, load WASM, instantiate a module, or call any Rust interpreter method.

Two threads have distinct responsibilities:

1. Off-audio worker creates and validates a unique immutable candidate, then calls `publish(ptr)`. The worker maintains ownership until publication succeeds; a rejection means the caller retains the unpublished pointer. The only reclaim path is `collectRetired()`, which must happen off the audio thread.
2. Audio thread calls `rtBeginBlock(fadeFrames, doubleEngineBudgetOk)` at its block start. If a previous engine still needs collection, a fade is unfinished or no candidate exists, no switch occurs. The audio side must then choose `rtActive()` or fixed-4095-sample delayed Dry. It calls `rtAdvanceFrame()` exactly once per emitted audio frame (never per channel). An optional fade of 2..8192 frames is only permitted when measured CPU budget can sustain two engines and their outputs already have **equal compensated PDC**.

The retiring pointer is placed in a lock-free single slot, rather than freed on the audio thread. If a module traps, `rtFaultActive()` reverts to the still-held old engine if possible, otherwise returns `nullptr` from `rtActive()` so the caller can render safe Dry while a faulted handle waits for worker collection. `reclaimWhenStopped()` is **only** called after the host has stopped audio and the worker has stopped publishing/collecting; the caller owns all returned distinct pointers and destroys them off RT.

## Important boundaries

- This mechanism makes **pointer handoff and retirement** allocation-free/lock-free on x64. It does **not** certify that `fw_native_process`/Wasmi is allocation-free, bounded enough, or safe to invoke from `IAudioProcessor::process`. Calling it on audio thread is **not authorized** by these tests.
- It assumes **one producer/collector and one audio consumer**, unique prepared pointers not republished while active or retired, and a stopped-state teardown barrier. The caller must implement these lifetime rules; the pointer queue itself is not a general shared_ptr reference counting system.
- A fade stores just coefficients; it does not perform audio rendering or implement latency padding. Never use it to mix paths with mismatched PDC. A zero-fade switch is the only permissible fallback when doubled engine CPU budget is insufficient.
- No native GUI, file Drop/Browse/Reload, version pinning, explicit semantic engine slot bindings, automated spectral DSP audio or real FL Studio test is claimed.
- The deterministic Release C++ regression covers exact fade endpoints, nonblocking pending/retired backpressure, hard-switch budget fallback, fault rollback, missing-engine Dry and concurrent pointer retirement. Pass/failure is via always-on checks, not debug-only assert.
