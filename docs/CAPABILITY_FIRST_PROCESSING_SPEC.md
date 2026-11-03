# Capability-first processing contract — progressive migration

Owner: [#332](https://github.com/kinoko34077/frequency-warp-vst/issues/332). This file defines the intended cross-layer contract and its acceptance boundary; it **does not claim implementation** of missing streaming/codec capabilities. Subordinate technical owners remain #79 (numeric UI), #321 (frequency bounds), #183 (Web UI), #3/#5 (DSP mathematics). See [capability catalog](CAPABILITY_API_CATALOG.md) and [shared DSP](SHARED_DSP_ARCHITECTURE.md). User-fixed defaults: positive processing lower L=0.001Hz, no independent Engine A floor; `L<H`.

## 1. Separate meaning from execution

- **Requested**: Immutable accepted value(s) in their mathematically relevant domain (Hz, ratio, coordinate, integer count, or exact symbolic/rational expression *when a real use case requires it*). Frequency display units and slider snapping are views. Existing canonical owner: `parameter-binding.mjs` / `parameter-units.mjs`; Rust frequency-map remains in `core/`. Do not build another parser or duplicate canonical store.
- **Capability**: Facts about an actual backend instance, input, output sink and host: sample rate, Nyquist, supported channel topology, codec, max processing block, frequency-transformation feasibility, latency, memory/CPU availability, output container format and writable destination. Separate invariant format constraints from resource estimates and experimental DSP-quality limitations.
- **Plan**: Derived `{requested, effective, status, reasonCodes, estimates, strategy}`. Status = `supported | partial | unavailable`. No silent substitution, truncation or disposal of requested user values. `partial` only when a **specific observable** part of the requested operation can run; state exactly which part did not run. Distinguish *theoretical validity* / *backend accepts setting* / *actual acoustic accuracy*.
- **Execution**: Stateful host adapter performs Plan and produces applied/rejected acknowledgments, progress, cancellation and cleanup. Web/Worklet/offline/native use the SAME Rust frequency transformation; a UI preview or a successful input ACK does not count as proof of actual output quality.

Do not change user settings to fit backend limits. Only explicit opt-in user selection changes the request. A violated physical boundary (e.g. target >= Nyquist) is an *execution capability*; NaN/Infinity or mathematically undefined expressions are invalid domain input. Browser memory exhaustion and input decoder failure should isolate only the affected job, leaving known-good source/audio intact.

## 2. Audio source contract

`SourceInfo` identifies encoded size, format, duration/sample frames (64-bit-safe count where available), channel layout, sample rate and source generation; `readFrames(start,count)` supplies a **bounded** decoded chunk with cancellation, backpressure, finite buffer lifetimes and accurate seek. The existing Web `file.arrayBuffer() -> decodeAudioData() -> Float32Array copies` is NOT a streaming decoder.

Migration order:
1. Characterize existing Web limits: 75MB rejection; silent min(600 seconds, length); silent min(2 channels, source channels); 40M samples export. Capture regression evidence for >75MB, >600s, >2ch without allocating unbounded memory.
2. Prove chunk read for PCM WAV with `File.slice` (including offset, endianness, sample width, chunk/metadata variants and damaged-file handling). Preserve the full source duration and sample-accurate seek. The reader must never return more than its bounded request or read the whole file.
3. For compressed formats, survey actual browser decode capabilities; use a verified streamed decoder, or keep a clearly-labelled bounded legacy decoder as fallback. Do NOT falsely claim `decodeAudioData` streams.
4. Replace full `AudioBuffer` source playback by a bounded producer/ring-buffer AudioWorklet transport **only after** real 128-frame, seek/loop, iPhone suspend/resume, underrun and rollback tests pass. Keep old path for compatible files during migration.

Unlimited input file size means **no arbitrary product cutoff**; individual allocations, browser APIs and storage are still finite. Resource plan must reject or degrade the *operation*, not corrupt or truncate the original source. Never silently downmix or discard a channel. If a host is stereo-only, state this and ask for/offer an explicit supported channel selection or arrangement.

## 3. Streaming export contract

Keep one persistent Rust Stream across successive input blocks, including algorithmic delay/overlap and flush. Provide chunked writer with bounded output buffers and cancel/close/cleanup. Any `resume` claim requires a serializable checkpoint for both DSP state and output writer; otherwise restart explicitly. Output sinks differ: File System Access streaming may be available in some browsers; portable browser-download fallbacks may require buffering and must expose that limit. RIFF/WAVE has finite 32-bit chunk sizes; use a verified RF64-capable writer or split/alternate format before crossing that bound. Preserve channel identity, sample count, latency correction and offline↔realtime consistency across chunk boundaries.

## 4. DSP ranges and host adaptation

The physical FFT or partial-tracking resolution is not the mathematical frequency domain. User-set F/H/P/R may remain theoretical when not representable by a host. The output of a capability query must distinguish user model from current engine properties; no independent hard-coded 20kHz/fixed-ratio/fixed-hold default policy unless justified by current backend/API constraints and recorded as such.

Existing `fw.frequency.bounds` owns dependent requested L/H behavior. `Stream` owns actual backend validation; Web preflight only mirrors that contract and MUST NOT silently overwrite user canonical state. Native host adapters must receive the same **0.001Hz initial requested L**, including any retained legacy Engine A alias; max block/channel/automation caps are host contract properties, not evidence of generic semantic limits. The first code slice under #332 aligns these defaults; it does not remove other caps.

## 5. Acceptance / milestones

### A0 observed current-contract inventory

Source readback on `main@89105eaa7a9e73862d0cc4411f5976e2ea7da322` (2026-11-04). This records current behavior, not the target architecture. A limit is called physical/format/ABI only where that boundary is explicit; other fixed constants remain implementation or product caps until separately justified.

| Gate / owner | Requested value and current effective behavior | Limit class / visible fallback | Existing evidence and gap |
|---|---|---|---|
| Web frequency controls: `stream-parameter-contract.mjs`, `virtual-root-plan.mjs` | L/H `0.001..20,000Hz` (plus `H < Fs/2`); P `0..20,000Hz`; R positive finite; pitch ratio `1e-12..4` (rational capability `0.25..4`); carrier `-1..20,000Hz`; UI axis shift/slope `-4..4`, physical shift `±20,000Hz`; virtual-root F `0.001..5,120,000Hz`, numerator `-128..128`; Crusher hold integer `0..1,000,000,000`. Values are preflighted; unsupported audio settings are rejected rather than silently rewritten. | Nyquist is physical. These other constants are current DSP/host support bounds, not universal mathematical bounds. | `stream-parameter-contract.test.mjs` covers boundary/rejection and exact snapshots; `virtual-root-plan.test.mjs` covers rational capability decisions; `crusher-visual.test.mjs` covers hold conversion. No shared runtime capability query yet. |
| Native requested L: `core/src/lib.rs`, `fwengine-stream`, `fwengine-warp-adapter` | Default is the shared `0.001Hz` constant, including the retained legacy A alias and neutral event. This is the requested setting only; it does not establish sub-Hz PCM fidelity. | Default-value contract; no fallback or value substitution. DSP resolution/quality is a separate property. | PR #333 exact-head Rust/S4a and Windows VST3 checks passed. |
| PCM WAV source: `wav-chunk-source.mjs`, `app.mjs` | `Blob.slice` reads bounded windows (8192 frames per app iteration); no fixed encoded-size or 600-second cutoff. The full source frame count/duration and all source channels remain in the request. The current preview still assembles full per-channel Float32 buffers. | Reader I/O is bounded; playback is not streaming. If the current preview cannot fit the memory plan, it returns unavailable rather than truncating the source. More than two channels are reported unsupported by the preview host, not silently discarded. | `wav-chunk-source.test.mjs` covers virtual 120MB/625s reads, 4ch source decoding, window bounds, abort and memory-plan refusal without materializing the large source. Browser/Offline checks cover the integrated path; real-device memory acceptance is separate. |
| Compressed source: `app.mjs`, `processing-capability.mjs` | Compressed formats still use whole-file `arrayBuffer()` / `decodeAudioData()` after a memory estimate. Unsupported or over-budget requests fail explicitly; no streamed compressed decoder exists. | Browser decoder and available-memory capability, not a fixed product byte/time cap. The current operation can be unavailable. | `wav-chunk-source.test.mjs` checks compressed predecode admission; codec-specific streaming remains unimplemented. |
| Buffered preview: `processing-capability.mjs`, `app.mjs` | Estimates working set as frames × channels × 4 × 5 against current browser memory data. If it cannot safely fit, the full requested source remains recorded but preview is unavailable. | Runtime memory capability of the existing buffered host; there is no ring-buffer streaming playback yet. | Planner tests cover supported and insufficient-memory outcomes without large allocations. No actual mobile low-memory/underrun evidence. |
| Rust/WASM processing and offline export: `core/src/lib.rs`, `processor.worker.mjs`, `export-policy.mjs` | Core accepts only `1..=2` channels and at most `40,000,000` combined samples; worker allocates full source/destination buffers and exports at most two channels. | Current ABI and allocation cap, not general N-channel or streaming support. Export is rejected over the cap. | `export-policy.test.mjs` checks the 40M boundary without allocating audio; no chunk-continuity/memory-budget export test on main. |
| Native stream adapters: `fwengine-stream`, `fwengine-warp-adapter` | Fixed channel topology and preallocated buffers; stream calls accept at most 2 channels and 2048 frames. | Current host ABI/fixed-buffer contract. Raising it needs an explicit ABI/state design. | Native/WASM S3a/S4a and Windows VST3 checks cover the current ABI; no N-channel acceptance is claimed. |
| WAV output: `app.mjs::makeWav` | Current main still produces a full PCM16 RIFF/WAVE buffer; no streaming writer is connected. RIFF chunk-size bounds remain a format limit. | Whole-result allocation plus the file-container limit. The remote `feat/332-streamed-wav-output` candidate is not on main. | `export-policy.test.mjs` verifies count rejection, not chunk continuity, cancellation, or RF64 output. |
| Cancellation and recovery: `app.mjs`, Worker | A newer load invalidates an older load and preserves the previously playable source until replacement succeeds. No checkpoint resumes long export from its previous position. | Stale-load cancellation and atomic source replacement exist; resumable export and CPU-driven quality degradation are not implemented. | Current replacement/worker tests cover failure isolation, not export resume or adaptive quality. |

**A0 status:** the source inventory and bounded synthetic evidence for the current import/export gates are now recorded. Those fixtures prove bounded reader windows and explicit admission/rejection behavior; they do not prove unlimited memory, real-device streaming playback, N-channel DSP or streamed export. Keep A2 limited to the merged bounded PCM-WAV/buffered-preview slice and A3/A4/A6 OPEN until their respective end-to-end acceptance passes.

A0: documented complete inventory of each gate: user-semantic / host API / physical / resource / legacy arbitrary, including path, source value vs effective result, fallback and owner. Any current state not verified live is unknown.

A1: native/Web requested L default parity and one-owner range semantics. Tests prove low=0.001 on native creation and no independent A control; do not promise 0.001Hz PCM fidelity.

A2: PCM WAV chunk reader and bounded source cache prove longer than 600s and larger than 75MB without full-buffer copies. Existing small-file playback must remain functional. 3+channels must never disappear silently.

A3: continuous stateful chunk export + writer. Verify streamed output bit/sample alignment, boundary, cancel, recovery, memory budget and file container integrity.

A4: multi-channel DSP topology and measured CPU/memory-aware scheduling without assuming independent mono processing is always acoustically equivalent.

A5: mathematical range/capability descriptions across F/H/P/R, ratio, shifts and Crusher. Extend existing owner APIs, avoid speculative general symbolic engine.

A6: real user scenarios + negative tests for missing codec, low memory, seek/loop, cancellation, >600s, >75MB, 3+ch, unsupported backend range, reset, stored state and native automation. PR-head tests and main/Pages verification are necessary but not sufficient for field UX acceptance.

Changes are incremental and independently reviewed. **No milestone claims full architecture finished before its user-observable acceptance passes**. See #332 for current status, blockers and next authorized action.
