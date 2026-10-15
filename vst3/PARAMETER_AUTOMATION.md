# VST3 DAW automation registry — fixed shell contract v1

Owning task: [#86](https://github.com/kinoko34077/frequency-warp-vst/issues/86), parent [#83](https://github.com/kinoko34077/frequency-warp-vst/issues/83).

This maps existing **audio-relevant** Frequency Warp controls, not merely their on-screen range input positions, to stable VST3 parameter IDs. FL Studio or another host can enumerate them in the plugin's generic parameter editor and author automation. The S2 binary processes the automation queues with sample offsets, while its audible output remains fixed delayed Dry **until the Rust spectral DSP is attached in S4**. Host enumeration/Validator passing does not prove an actual FL automation clip was tested (S5).

**Do not change existing Processor/Controller Class IDs or IDs 0..12**. Plugin classes remain fixed. IDs 13..33 complete the independent controls below. IDs 34..63 are reserved shell slots; IDs 64..127 are persistent generic engine slots (initially unbound and semantically neutral). An engine module must never silently reuse a slot for a different semantic ID after project restore.

| ParamID | Web source | Canonical physical meaning, limits | Default |
|---:|---|---|---:|
|0|wet|Wet [0,1]|1|
|1|Bypass (VST3)|Bypass off/on|off|
|2|low|Lower band .001–20000 Hz|20|
|3|high|Upper band .001–20000 Hz|16000|
|4|invert|Inversion amount [0,1]|0|
|5|curvature|Frequency coordinate curvature p [0,1]|1|
|6|axis-shift|Coordinate displacement u [-2,2]|0|
|7|axis-pivot|Physical pivot [0,20000] Hz; zero special|350|
|8|axis-slope|Signed physical slope [-4,4]|1|
|9|zero-reflect|Reflection synthesis fraction [0,1]|1|
|10|ring-enabled|Ring enable switch|off|
|11|crusher-enabled|Crusher enable switch|off|
|12|quality|FFT size index 0/1/2 (1024/2048/4096)|0|
|13|zero-decay|Reflection coefficient [0,1]|0|
|14|carrier|Ring carrier [0,20000] Hz|350|
|15|carrier-link|Ring Fold carrier link off/on|off|
|16|crusher-bits|Bitcrusher bits [2,16], integer|8|
|17|crusher-hold|Crusher clock normalized relative to host Fs, 0=hold|12000 Hz at 48kHz|
|18|rational-enabled|Rational harmonic layout off/on|off|
|19|fundamental|Fundamental F [20,2000] Hz|350|
|20|denominator|Denominator m [1,64] integer|4|
|21|numerator|Numerator n [-128,128] integer|-3|
|22|harmonic-index|Harmonic index q [1,32] integer|1|
|23|pitch-ratio|Pitch ratio r [.25,4]|1|
|24|harmonic-pivot-link|H ↔ Pivot opt-in link|off|
|25|engine|Engine A/B select, 0/1|1 B|
|26|engine-auto|Engine automatic selection off/on|off|
|27|a-min|Engine A low cutoff .001–20000 Hz|20|
|28|a-quality|Engine A quality fraction [0,1]|0|
|29|a-band|Engine A band count [1,8]|1|
|30|a-reverb|Engine A reverb fraction [0,1]|0|
|31|mode|Reciprocal / Fold L / Fold H|Reciprocal|
|32|outside|Pass / Kill out-of-band|Pass|
|33|overlap|STFT overlap 4× / 8×|4×|

The host stores/automates VST3-normalized values in [0,1], and the `parameter_registry.h` bridge explicitly converts to physical DSP values. Frequency L/H and A-floor use the existing double-logarithmic 20 Hz breakpoint, rather than a linear percentage of Hz. Pivot and carrier use explicit zero Hz and a positive sub-Hz range. Crusher clock follows the *relative-to-Fs* Web semantics; its host automation is a normalized relative clock and displayed physical Hz is recomputed when sample rate changes. A sample rate change must not arbitrarily reinterpret a permanent physical pitch/frequency parameter.

DAW automation of a linked input such as H/P or carrier/Fold requires consistent deterministic transaction ordering: apply all events in each sample frame in host queue order, then derive link target once. Simultaneous explicit automation of source and target needs a specified deterministic precedence and test before S4. Host UI mouse changes must call VST3 `beginEdit/performEdit/endEdit` from the editor; directly changing processor state on the GUI thread would bypass host recording. Native editor remains S3; host generic parameter view is available from S2/S3 automation registration.

`sine-pitch`, `sine-cent`, `sine-hz`, `graph-log` and preview `sine-enabled` operate only in the browser's reference audio/display, not the Frequency Warp VST3 spectral effect. They are **not silently re-labelled as DSP controls**. If later added to the VST3 interface they must obtain their own persistent IDs and tests. Web #79 unit menu remains an independent display feature.

Test commands: `fw_shell_automation_test` plus `fw_shell_delay_test`, Windows VST3 SDK Validator and, when the real DSP/GUI is present, manual FL Studio automation clip write/read, project reload and multi-instance checks. A test passing the registry does not mean the sound has already changed when editing a knob.


## S4b1 — audible core Stream automation subset (pending host-physical validation)

The real VST3 Processor sends the following confirmed fixed ParamIDs to the
`org.kinotch.stream` package via off-audio-thread PCM mailbox events. Its
normalized DAW values are converted using `parameter_registry.h` at the
current host sample rate, then applied at their source-frame offset:

| ParamID | Canonical module value | Host normalization |
|---|---|---|
| 2 Lower Frequency | Hz | existing logarithmic FrequencyBand |
| 3 Upper Frequency | Hz | existing logarithmic FrequencyBand |
| 4 Invert | fraction 0..1 | continuous |
| 5 Curvature | fraction 0..1 | continuous |

Every PCM packet carries the current 4-value snapshot at offset0. Further
distinct param/sample changes are encoded in sample order. A 128-event limit
causes the VST3 audio callback to **split the PCM packet first**, before
consuming later host parameter points. Multiple updates of the same control
at the same sample have one sample-effective final value. No heap/lock/WASM
work is allowed on the audio callback. A worker checks its accepted manifest
identity and strips these core-only events for unbound demo Identity/Gain
modules rather than crashing an unrelated module.

**Remaining:** Other IDs 6..33 are exposed and automatable in the host but
their actual shared Stream binding is still pending independent S4b semantic
mapping; registering a visible host knob alone is not audible DSP support.
GUI beginEdit/performEdit/endEdit for frequency controls, CPU under dense
automation, project module identity persistence and real FL Studio/REAPER
automation clip playback require later gates. The unit-selector Web/UI
development Issue #79 is separate.


## S4b2-B — host audio-binding extension

After S4b2-A validated exact native/WASM `Stream` setters, the actual
VST3 Processor additionally forwards the following stable ParamIDs to
the **same** shared spectral DSP worker, preserving sample offsets:

| ID | Physical module value | Canonical Rust setter |
|---|---|---|
| 6 Axis Shift | −2..2 axis units | `Stream::set_transform` |
| 7 Axis Pivot | 0..20000 Hz | `Stream::set_geometry` |
| 8 Axis Slope | −4..4 | `Stream::set_geometry` |
| 9 Reflection Synthesis | 0..1 | `Stream::set_zero_reflect_gain` |
| 10 Ring Enabled | 0 or 1 | `Stream::set_transform` |
| 13 Reflection Decay | 0..1 | `Stream::set_zero_reflect_decay` |
| 18 Rational Layout | 0 or 1 | `Stream::set_transform` |

The strict `StreamHostEvents::kBindingIds` table has **11** entries: IDs
2,3,4,5,6,7,8,9,10,13,18. Each new bounded PCM chunk snapshots those
11 current physical values at offset0. Changed sample positions consume
additional entries; packets are subdivided before crossing the 128-event
ABI limit. The separate demo Gain ID64 is unchanged. Other DAW-visible
controls still require a verified physical semantic mapping.

No separate DSP mapping formula is implemented in the VST3. Web and native
WASM use the same `Stream` setters; audio worker and Controller remain
separate from the host RT thread. This does NOT attest FL Studio host
automation playback; use S5 for actual host integration and listening.


## S4b3-B — Bitcrusher physical controls and legacy module capabilities

The stable host list adds three existing, separately automatable ParamIDs **without renumbering any ID**: 11 Crusher Enabled (0/1), 16 Crusher Bits (2–16 integer), and 17 Crusher Clock (0..host Fs Hz; exact zero means hold the first sample). The host forwards the normalized values through the shared `parameter_registry.h` converter to the same Rust `Stream::set_crusher` used by the browser. Relative clock conversion uses `round(Fs/min(Fs,Hz))` samples, clamped to 1..1e9; zero rate maps to sample-hold 0, and disabled crusher maps to 0 quantizer bits.

The current **14 physically connected Stream IDs** are 2,3,4,5,6,7,8,9,10,11,13,16,17,18. Every host PCM segment begins with 14 snapshots in physical units. Additional offset events use stable IDs and dynamic 128-slot packet splitting. Remaining host-visible IDs still require independent semantic binding; generic Gain ID64 and shell Wet/Bypass remain separate.

**Exchangeable legacy engine safeguard:** the optional WASM export `fw_supported_param_mask() -> i64` advertises a bitset indexed by immutable ParamIDs. The off-RT Rust runtime validates this capability mask and exposes it through native `fw_native_stream_control_mask`. The worker intersects the module-supported mask with the host's current 14 IDs before forwarding; an older `.fwengine` without that export gets only the original safe IDs2–5, while demo Identity/Gain retains ID64. This permits a fixed rebuilt-once VST3 shell to load older or newer modules without incorrectly sending unsupported automation. **Old engines may not audibly react to newly added parameters**; absence of support is not silently treated as an implementation of those DSP functions.

Cross-platform checks: shared Rust native/WASM real audio parity, sample24 crusher event and non-placebo difference, zero-Hz freeze, malformed events, host 14-ID normalized conversion/128-event cap, legacy-module four-ID fallback through a real off-RT native worker, official Windows SDK Validator. This is *source/CI* acceptance only; actual FL Studio and second DAW automation/project reopen/CPU/long-playback remain S5.


## S4b4-B — Engine A settings over the same physical Stream bridge

The immutable DAW ParamID list now contains **18 actually connected Stream inputs**:
`2,3,4,5,6,7,8,9,10,11,13,16,17,18,27,28,29,30`.
The four new IDs invoke the exact shared Rust `Stream` implementations:

| ParamID | Physical transport and Rust setter |
|---|---|
| 27 Engine A Floor | .001..20000 Hz; `Stream::set_a_options(minHz,reverb)` |
| 28 Engine A Quality | normalized physical fraction 0..1; rounded ×100 to integer `Stream::set_a_quality(percent)` |
| 29 Engine A Bands | integer 1..8; `Stream::set_a_peak_band(bins)` |
| 30 Engine A Reverb | fraction 0..1; `Stream::set_a_options(minHz,reverb)` |

This exposes the existing Engine A controls; it does **not** repair the independently tracked Engine A quality/identity issue #48. Conversion and event buffering remain host-owned 128-slot non-RT packets with sample offsets; values in DAW project state keep the same IDs, domain and normalized format. The runtime's optional module capability mask is a **module-to-host intersection**: the 18-ID module accepts all 18, a prior 14-ID `.fwengine` continues receiving only its 14, and pre-capability modules continue receiving safe IDs2–5. Host UI enumeration is independent from module support, and unsupported module parameters do not silently gain a new meaning.

The Stage A native/WASM reference proves Engine A 100% quality audio with a bounded 40-million-fuel Wasmi block limit for modules advertising ID28; on the test signal, 100%-quality consumed 12,094,647 fuel per 128 samples. This is **not** a proof of DAW real-time CPU sufficiency, which remains S5 along with FL Studio and second-host actual project restoration.
