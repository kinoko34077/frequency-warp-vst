# S3b3 — bounded audio-to-worker PCM transport (experimental, NOT installed plugin audio)

Owning [#97](https://github.com/kinoko34077/frequency-warp-vst/issues/97) · parent [#83](https://github.com/kinoko34077/frequency-warp-vst/issues/83).

`src/async_pcm_mailbox.h` holds two fixed-capacity single-producer/single-consumer queues, with one audio-side input writer/returned-output reader and one **non-real-time worker**. Audio-side routines copy at most 128 frames × 2 channels and 128 sorted 16-byte `FWNativeEvent` records per call; they allocate no heap, never block, call no file/OS API, take no mutex and **never execute WASM**.

The worker calls the existing #90 native C ABI only on its own thread. One block of audio and its sample-offset events travel through this path:

```text
Audio process        fixed-size InPacket (source frame + generation)
  ↓ RT enqueue           ↓
  ↳ 4095-sample Dry     SPSC queue → worker → fw_native_process(Wasmi)
                         ↓              ↓
  RT wet due-read ← SPSC completed OutPacket (source + 4095 − moduleLatency)
  ↓
  wet if correct packet is ready at its entire-chunk deadline,
  otherwise emit PDC-aligned Dry (no stale generation or tardy half-chunks).
```

Latency scheduling: the native module's own declared audio output latency `L` is matched to the fixed shell PDC `4095` by holding the worker output for `4095 - L` additional samples; the module manifest must be previously validated and have `0 <= L <= 4095`. A module that reports 2047 samples internal delay receives 2048 samples of host padding. A module that reports 0 receives all 4095. The pipeline does not pretend a sample has been processed when the worker has not finished before its deadline; missing, queue-full, late, invalid generation, non-finite PCM or status failure results are replaced by the already time-aligned Dry. Repeated fallback chunks may be audible; S5 must assess glitches and CPU scheduling.

The worker may allocate and may take nonzero CPU time; only the DAW audio callback is kept bounded. An atomic generation tag means results from an earlier engine configuration cannot become new wet audio. Engine switching must keep old native handles alive until worker use completes; the worker owns instance loading/retirement and **not** the audio thread. Current `fw::SwapMailbox` ownership primitive is separate and unchanged.

## Verification and remaining work

- Pure C++ cross-platform tests: precise 4095 deadline, stereo planar audio, parameter event at offset 64, zero-frame flush, late entire-chunk rejection, generation discard, invalid worker response, input overflow, module latency 2047 scheduling.
- Native C++/Rust staticlib smoke: the **same unchanged executable** reads Identity and Gain-half `.fwengine` packages, prepares both outside audio, uses two separate C++ worker threads and proves wet PCM .8 → .8 vs .8 → .4, then gain automation at sample 64 .4 → .2 with identical ABI and fixed reported PDC.
- This tests the **transport plus real WASM execution**, but it has **not been wired into Steinberg VST3 Processor** yet. S3b4 must implement plugin-owned worker lifetime/start/stop and module-loading message path, f32/f64 host adaptation, deterministic event splitting, 4095 Dry/Wet output selection and full VST3 SDK validation under actual process calls. S3c Browse/Drag/Drop/Reload and rollback GUI, S4 shared Rust spectral DSP and FL Studio S5 remain distinct.

No installer, no publication or claims of musical audio quality follow from this experiment.
