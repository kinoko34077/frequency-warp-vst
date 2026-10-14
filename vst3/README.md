# Windows x64 VST3 fixed shell — modular WASM integration in progress

Owning Issue: https://github.com/kinoko34077/frequency-warp-vst/issues/83.
No installer or VST3 binary has been publicly distributed.

Stable class IDs: Processor D51B3C205C574E31B40D7B64A2E8F719; Controller F8C2D41E84B9475BB5DC4E2FB948A0D3. Exactly 128 stable host ParamIDs: 0..33 named Frequency Warp controls, 34..63 reserved, 64..127 generic unbound. See PARAMETER_AUTOMATION.md. Actual audible spectral automation still requires S4 and real FL Studio testing S5.

## Current fixed-shell structure

- SDK Processor: mono/stereo, f32/f64, in-place, variable blocks, zero-frame automation, state v1.
- S3b4-A audio path: 128-frame preallocated planar PCM jobs, generation/deadline-qualified async Wet and host Wet/Bypass blend; no Wasmi, heap, locks, file I/O in the audio callback.
- Fixed PDC 4095 samples; absent/late/failed module falls back to PDC-aligned Dry.
- The verified Rust Wasmi static library is linked into the Windows VST3 itself (not loaded as an external DLL). A stable C ABI major check runs during non-RT Processor initialize.
- S3b4-B native_worker_service.h manages standalone non-RT worker start/stop, bounded validated single-file .fwengine packages, Identity/Gain replacement, invalid-file rollback and worker teardown. Linked C++/Rust Linux+Windows native tests prove the same binary swaps DSP code via the package only.
- **Critical remaining gate**: real VST3 Processor still does not instantiate/own the worker or expose Browse/Drop/Reload in the Controller. Host automation events are not yet mapped to a production Frequency Warp Rust spectral engine. Until selected and connected, default VST3 output remains delayed Dry.

## Build and verification

Build official Steinberg VST3 SDK 3.8.x recursively, Visual Studio 2022 x64, Rust MSVC target, CMake 3.25+:

    cargo build --release --lib --manifest-path fwengine-runtime/Cargo.toml
    cmake -S vst3 -B build/vst3 -G "Visual Studio 17 2022" -A x64 -DFW_VST3_SDK_DIR=C:/dev/vst3sdk -DSMTG_CREATE_PLUGIN_LINK=OFF -DSMTG_RUN_VST_VALIDATOR=ON -DFW_NATIVE_ARCHIVE=C:/repo/fwengine-runtime/target/release/fwengine_runtime.lib
    cmake --build build/vst3 --config Release --target FrequencyWarpShell
    cmake --build build/vst3 --config Release
    ctest --test-dir build/vst3 -C Release --output-on-failure

Windows CI compiles actual VST3 with Rust Wasmi staticlib and runs official Steinberg Validator and always-on C++ regressions. S3 native CI runs actual Identity/Gain .fwengine files and verifies worker lifetime on Linux and Windows. None of these is a physical FL Studio or second-DAW test, nor a release approval. Steinberg SDK remains governed by its upstream license.

## S3b4-C: actual Processor lifetime and module message route

The native Windows VST3 Processor **now owns its own** `NativeWorkerService`.
`setActive(true)` starts the worker; `setActive(false)` joins it and fully
detaches the mailbox **after callbacks are quiescent**. Each plugin instance
has separate thread, engine state, PCM queues and 4095-frame Dry ring.
No Wasmi execution or allocations occur in `Processor::process`.

The Host-mediated `IConnectionPoint::notify(IMessage*)` transport accepts
**message ID** `FrequencyWarp.LoadFwengineV1` with **binary attribute**
`package` holding at most 8 MiB of complete `.fwengine` bytes. A valid
request is copied and queued for non-RT prepare/ABI validation; success here
means **queued, not activated**. A bad module keeps the last valid worker
engine, and the absent/late/broken case outputs latency-compensated Dry.
The message should only be sent from the Controller's non-audio UI/host route;
the native Browser/Drop/Reload editor and visible per-file status are still
S3c, and project-save module identity/semantic bindings are S4.

This CI stage proves VST3 Processor native worker ownership and build/Validator
compatibility, but **does not prove** the physical FL Studio host forwards the
binary message or plays an actual selected module. S3c/S5 must test these
separately. The 34 DAW-exposed host parameters remain stable and observable;
all spectral knobs only become audibly effective after the genuine S4 DSP
module and binding schema are installed.
