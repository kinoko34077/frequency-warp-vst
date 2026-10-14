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
