# Windows x64 VST3 fixed shell — modular WASM integration in progress

Owning Issue: https://github.com/kinoko34077/frequency-warp-vst/issues/83.
No installer or VST3 binary has been publicly distributed.

Stable class IDs: Processor D51B3C205C574E31B40D7B64A2E8F719; Controller F8C2D41E84B9475BB5DC4E2FB948A0D3. Exactly 128 stable host ParamIDs: 0..33 named Frequency Warp controls, 34..63 reserved, 64..127 generic engine-bound after live authorization. See PARAMETER_AUTOMATION.md. Sample-offset host→WASM generic event routing is source/CI accepted under Issue #172; actual trusted GUI enablement, production spectral parameter contract and physical FL Studio/second-host proof remain unfinished.

## Current fixed-shell structure

- SDK Processor: mono/stereo, f32/f64, in-place, variable blocks, zero-frame automation, state v1.
- S3b4-A audio path: 128-frame preallocated planar PCM jobs, generation/deadline-qualified async Wet and host Wet/Bypass blend; no Wasmi, heap, locks, file I/O in the audio callback.
- Fixed PDC 4095 samples; absent/late/failed module falls back to PDC-aligned Dry.
- The verified Rust Wasmi static library is linked into the Windows VST3 itself (not loaded as an external DLL). A stable C ABI major check runs during non-RT Processor initialize.
- S3b4-B native_worker_service.h manages standalone non-RT worker start/stop, bounded validated single-file .fwengine packages, Identity/Gain replacement, invalid-file rollback and worker teardown. Linked C++/Rust Linux+Windows native tests prove the same binary swaps DSP code via the package only.
- **Current R3C2D6 acceptance (2026-10-16)**: Processor already owns a non-RT `NativeWorkerService`; Controller already has native Browse/Drop/Reload, and generic 64..127 sample-offset event packets are connected to live WASM through a worker-verified ticket (PRs #193/#194). D0–D6 PRs #195/#197/#198/#199/#200/#202/#203 added complete descriptor attestation, saved FWS3 authorization requests, live Wasmi candidate ledger preparation and a pure commit guard; #203 main `47a0e80a55de821b86c081ca8f613ca6e6c3878d` passed Linux/Windows real Wasmi, official Windows Steinberg Validator and offline exact-head and exact-main checks. **D7 still missing**: explicit atomic new-ledger FWS3 project commit; trusted WebView2 begin/perform/end for generic slots and DAW→GUI feedback follow separately. No physical FL Studio/second-host acceptance, installer or binary release.

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
separately. The 128 fixed DAW-visible host ParamIDs remain stable; 0..33 are named original controls and generic 64..127 remain inert unless worker-authorized;
all spectral knobs only become audibly effective after the genuine S4 DSP
module and binding schema are installed.

## S3c-A historical implementation stage — native Windows file editor (Browse/Drop/Reload)

The Controller now creates an actual `IPlugView` child HWND on Windows. It
offers a standard Browse dialog, optional Windows `WM_DROPFILES` and explicit
Reload. If a host does not route drag-drop to the child window, use Browse.
Only .fwengine file bytes (8 MiB hard cap) are copied on the UI thread and
sent via host-mediated `IMessage` to the Processor. The Processor queues
the validated candidate to the non-RT Rust worker. No filename, DLL, zip
extract or disk I/O is ever passed to `IAudioProcessor::process`.

A successful send only means **queued for verification**. This iteration
does NOT expose a worker-confirmed engine ID/version, error diagnostics, a
verified previous-engine Back action, or module identity persistence. The
editor never labels a new candidate as ACTIVE merely because sendMessage
succeeded. These are S3c-B/S4 acceptance gaps. GUI attachment, file dialog,
file drop, FL Studio automation clip and physical host playback still need
manual Windows host testing, not inferred from Steinberg Validator alone.

## S3c-B worker-confirmed request state and previous-engine Back

Controller now serializes module binary submissions with a monotonically
increasing nonzero request token. Processor passes that token to the non-RT
Rust worker; the worker atomically records `request-id/succeeded` **only
after verifying and preparing or rejecting** the candidate. A UI-thread
`FrequencyWarp.QueryEngineV1` message polls status and receives
`FrequencyWarp.EngineStatusV1` (completed request token, result, handled
count, accepted generation, worker status). An ACK with an unrelated token
cannot activate an editor candidate. Host deactivation cancels pending UI
verification and allows retry after reactivation; worker Faulted/Stopped
states are never shown as verified ACTIVE.

During one editor session, only worker-confirmed package bytes enter the
`VerifiedEngineHistory`: last valid package remains after malformed
selection, and Back re-submits the *previous verified package bytes* rather
than trusting a path that may have changed. A successful Back is committed
only after the worker ACKs that request. C++ Release regression covers
stale token, invalid package, verified Back, and cancellation. Native
Linux/Windows Rust worker fixture now also proves distinct success/failure
request IDs through actual Identity/Gain and bad ZIP.

**Still open:** D7 explicit atomic creation/commit of new verified FWS3 generic bindings; trusted WebView2 generic 64..127 host begin/perform/end and no-echo DAW-to-UI feedback; detailed per-module failure diagnostics and UI reload/recovery acceptance; production Frequency Warp spectral DSP/audio automation; actual FL Studio/second-host GUI, project save/reopen, multi-instance and file-drop tests (S5). The existing worker-verified FWS3 package/identity project save/restore code must not be described as absent.
No user-facing binary or installer has been published.
