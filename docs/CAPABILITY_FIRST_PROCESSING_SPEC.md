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

Source readback on `main@4a1e99b81e0f422d632237163a3b4f325375e5fa` (2026-11-04). This records current behavior, not the target architecture. A limit is called physical/format/ABI only where that boundary is explicit; other fixed constants remain implementation or product caps until separately justified.

| Gate / owner | Requested value and current effective behavior | Limit class / visible fallback | Existing evidence and gap |
|---|---|---|---|
| Web frequency controls: `stream-parameter-contract.mjs`, `virtual-root-plan.mjs` | L/H `0.001..20,000Hz` (plus `H < Fs/2`); P `0..20,000Hz`; R positive finite; pitch ratio `1e-12..4` (rational capability `0.25..4`); carrier `-1..20,000Hz`; UI axis shift/slope `-4..4`, physical shift `±20,000Hz`; virtual-root F `0.001..5,120,000Hz`, numerator `-128..128`; Crusher hold integer `0..1,000,000,000`. Values are preflighted; unsupported audio settings are rejected rather than silently rewritten. | Nyquist is physical. These other constants are current DSP/host support bounds, not universal mathematical bounds. | `stream-parameter-contract.test.mjs` covers boundary/rejection and exact snapshots; `virtual-root-plan.test.mjs` covers rational capability decisions; `crusher-visual.test.mjs` covers hold conversion. No shared runtime capability query yet. |
| Native requested L: `core/src/lib.rs`, `fwengine-stream`, `fwengine-warp-adapter` | Default is now the shared `0.001Hz` constant, including the retained legacy A alias and neutral event. This is the requested setting only; it does not establish sub-Hz PCM fidelity. | Default-value contract; no fallback or value substitution. DSP resolution/quality is a separate, currently unclaimed property. | PR #333 exact-head Rust/S4a and Windows VST3 checks passed. |
| Web source import: `app.mjs` | Rejects files above `75,000,000` bytes; reads the full file with `arrayBuffer()` and `decodeAudioData()`; keeps at most the first `600s` and first `2` channels. Longer duration and extra channels are silently omitted after decode. | Fixed implementation/resource caps; not encoded-format limits. No chunked source reader or channel-selection UI exists. | Existing entry tests exercise ordinary files only; no low-allocation >75MB, >600s, or 3+ channel regression fixture is present. |
| Rust/Web processing buffer: `core/src/lib.rs`, `processor.worker.mjs` | Current ABI accepts only `1..=2` channels and rejects more than `40,000,000` interleaved samples. Worker allocates full source/destination WASM buffers. | Current ABI/buffer capacity; not a general N-channel or streaming capability. Rejection is surfaced for export/process requests. | `export-policy.test.mjs` checks the count gate without allocating the boundary-sized audio. No chunk continuity or memory-budget test exists. |
| Native stream adapters: `fwengine-stream`, `fwengine-warp-adapter` | Fixed channel topology and preallocated buffers; the stream adapter accepts at most `2` channels and `2048` frames per call. | Current host ABI and fixed-buffer contract. Raising it needs an explicit ABI/state design, not a UI-only range change. | Native/WASM S3a/S4a and Windows VST3 checks cover the current ABI; no N-channel acceptance is claimed. |
| Offline WAV export: `export-policy.mjs`, `processor.worker.mjs`, `app.mjs::makeWav` | Preflight and Worker cap combined output at `40,000,000` samples and `2` channels; rendering and PCM16 RIFF output allocate the whole result. | Current product/memory cap plus the RIFF/WAVE container size boundary. No streaming writer or RF64 path. | `export-policy.test.mjs` verifies the 40M cap; current tests do not prove bounded-memory long export or behavior at RIFF size overflow. |
| Cancellation and recovery: `app.mjs`, Worker | A newer load invalidates an older load and keeps the previously playable source until replacement succeeds. Processing can fail/stop, but there is no checkpoint from which long work resumes. | Stale-job cancellation and atomic source replacement exist; resumable execution and resource-based quality degradation do not. | Existing source replacement/worker checks cover current recovery only; no resume/checkpoint or automatic capability-plan evidence. |

**A0 status:** the source inventory is now recorded, but the bounded low-allocation reproductions for the import limits and long export are still absent. Keep A0 PARTIAL until a selected migration target has a test that fails on the current behavior without large allocations. Preserve unknowns above as unknown; do not infer them from the passing current CI.

A0: documented complete inventory of each gate: user-semantic / host API / physical / resource / legacy arbitrary, including path, source value vs effective result, fallback and owner. Any current state not verified live is unknown.

A1: native/Web requested L default parity and one-owner range semantics. Tests prove low=0.001 on native creation and no independent A control; do not promise 0.001Hz PCM fidelity.

A2: PCM WAV chunk reader and bounded source cache prove longer than 600s and larger than 75MB without full-buffer copies. Existing small-file playback must remain functional. 3+channels must never disappear silently.

A3: continuous stateful chunk export + writer. Verify streamed output bit/sample alignment, boundary, cancel, recovery, memory budget and file container integrity.

A4: multi-channel DSP topology and measured CPU/memory-aware scheduling without assuming independent mono processing is always acoustically equivalent.

A5: mathematical range/capability descriptions across F/H/P/R, ratio, shifts and Crusher. Extend existing owner APIs, avoid speculative general symbolic engine.

A6: real user scenarios + negative tests for missing codec, low memory, seek/loop, cancellation, >600s, >75MB, 3+ch, unsupported backend range, reset, stored state and native automation. PR-head tests and main/Pages verification are necessary but not sufficient for field UX acceptance.

Changes are incremental and independently reviewed. **No milestone claims full architecture finished before its user-observable acceptance passes**. See #332 for current status, blockers and next authorized action.

