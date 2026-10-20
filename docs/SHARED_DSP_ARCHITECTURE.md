# Shared DSP Architecture — Current Canon

The same Rust core is built as native staticlib/C ABI and wasm32/WASM.
Web is only an audio host and UI. Future VST3 must consume the same
streaming interface (the native VST3 wrapper is not yet implemented).

## Ownership and duplication audit (#19)

| Concern | Single source | Usage |
|---|---|---|
| Curvature / Fold / Blend spectral mapping | core/src/lib.rs: map_frequency and warp_map_frequency | Rust DSP, browser graph via WASM |
| Fold input breakpoint | core/src/lib.rs: fold_frequency and warp_fold_frequency | Native Rust Ring coupling and Web readout via WASM |
| Streaming audio engines | core/src/stream.rs: Stream::process | AudioWorklet on WASM; native C ABI |
| WAV file export | core/src/stream.rs: warp_stream_render_f32_ext | Same Stream::process, offline host with latency compensation |
| Web audio transport, Dry/Wet | web-demo/app.mjs and realtime.worklet.js | Web host adapter only |
| Ideal harmonic F,m,n,q equations | web-demo/harmonics.mjs | Numeric *theoretical model*, not acoustic DSP |
| Mathematical independent reference | web-demo/mapping-oracle.test-helper.mjs | Test-only, not shipped to Pages |

Production browser code does NOT independently implement nonlinear
frequency mapping. It uses the SAME compiled WASM warp_map_frequency
export that the Rust streaming DSP uses. An independent test oracle is
valuable for detecting shared implementation errors but must never be
used as a second production algorithm.

## User-controlled Ring carrier link

Fold is defined in normalized S_p coordinates, where D=S_p(H).
The **input-side direction change point** is:
- Fold H: f_fold = S_p^-1((1-a)D)
- Fold L: f_fold = S_p^-1(a D)
- Blend: has no direction-change point.

With linked-carrier enabled and a Fold mode, Web sends carrierHz=-1.0.
Rust resolves it inside the streaming DSP from the *same mapping* every
audio block. When Blend is selected while link remains checked, the
UI explicitly indicates the manual carrier is temporarily used. This
carrier is separate from theoretical virtual fundamental H_virtual=F/m
in Issue #16. Ring Mod creates both f+c and abs(f-c) sidebands; it is
not a nonlinear inversion.

## Engines and current limitations

- 0: STFT peak-following / oscillator resynthesis. Tonal partials only;
  noise/residual handling incomplete.
- 1: FFT-bin reassignment / inverse FFT. Quantization and phase artifacts.
- 2: tracked STFT nonlinear Warp **then** time-domain Ring Mod. This preserves\n  Invert/Curvature, creates two sidebands and inherits the FFT N−1 lookahead.\n  An independent instantaneous Ring-only path is not selected by this engine.
- 3: tracked STFT nonlinear Warp **then** pitch ratio plus signed Hz offset\n  for tracked in-band partials. The
  parameter F is entered manually, not auto-detected.
- Unimplemented research paths (analytic linear invert, partial+noise
  residual R2.2, chirplet/nonuniform analysis) remain disabled in UI.

For streaming engines using STFT, quality FFT size is 1024/2048/4096;
hop=N/4 or N/8. Algorithmic latency is N-1 samples (not hardware
latency). WebAudio calls AudioWorklet with 128-sample quanta; this
quantum is not user-adjustable. Engine/FFT/hop changes cause a short
state rebuild and retain approximate playback position. Other knobs
update live without rendering the full recording.

The zero-frequency Fade path was fixed during #19 audit: previously
it returned 0Hz, then immediately skipped that component (identical
to Kill); it now applies a bounded experimental gain curve near the
negative-frequency boundary. Its actual audio quality remains unproven.

WAV export uses the same streaming Rust engine as live playback, but
whole-file processing may take substantial time. The export adapter
discards algorithmic lead-in silence and flushes tail samples. Separate
legacy R2.1 offline references remain for research and regression only.

## UI ownership and source-based UX criteria

Source: '利用者起点 UI/UX 設計原則' (user-provided Project Source,
586 lines read) UX-01/04/05/06/08/09/11/14/15.
High-frequency transport and Invert/Curvature/Wet/L/H are on the main
workstation beside the graph. Engine, Fold style, outside policy,
FFT/hop and zero-target settings are in an accessible modal. The
harmonic laboratory is a nearby tab with paired range/numeric controls;
toggle and return do not reset playback. On mobile, a single-column
layout replaces forced desktop miniaturization.

Chrome smoke and automated Rust/WASM tests establish feature
functionality. Human subjective usability, perceptual DSP preference,
and real iPhone audio performance remain UNVERIFIED pending actual
device/user testing. Do not claim 'small-child usability certified'
without a test.

## Proof and dependencies

CI: native cargo tests, shared Rust wasm32 compile, Node oracle and
real PCM output checks, Chrome 12-second playback/control/seek and
responsive mobile viewport. Pages only publishes app/graph/harmonics
UI, processor Worker/Worklet and Rust-built dsp_core.wasm.

History: PRs #11, #13, #15, #18; current UX/common refactor PR #20
(Issue #19). Research Issue #5 and incomplete candidate Issue #17
remain separate and are not automatically accepted by this UX change.

## 2026-10-13 UI extension and five candidate families (Issue #22)

Browser audition cap: 600 seconds (previously 120), source file size cap
75MB. Decoded PCM can require hundreds of MB at 48 kHz stereo;
full-buffer WAV export remains capped to 40,000,000 samples as a memory
safety bound. This means a long high-rate stereo file can be previewed
but its WAV may not be exportable from the browser; never present this
as successful 600-second export.

The mobile graph is capped to 255 CSS pixels, and its **inner frequency
plot** is mathematically square with equal Hz-to-pixel scale on x/y.
A 3-harmonic compact card is always visible immediately below the
graph. Expandable detail retains the graph in view; 3/5/7/12/16/24/32
harmonic count is controlled in Settings. Harmonic formulas remain an
ideal manual-F theoretical model, not detected notes.

A shared Rust DSP post-effect applies Bit Crusher quantization (2–16
bit) and optional sample-and-hold rate reduction (1–32 input samples)
to ANY selected engine. It is live-configurable via
warp_stream_set_crusher, and uses the same setting when exporting WAV
via warp_stream_render_f32_fx_ext; both preserve Rust native/WASM parity.
Bitcrusher alters time-domain sample resolution/hold; graph remains a
frequency-axis *ideal map* and does not draw broadband quantization noise.

### Five proposed implementation categories — factual status

| User candidate | Actual current implementation status | Boundary |
|---|---|---|
| Analytic signal + complex modulation (constant Hz shift, direct linear inversion) | **Offline R0/R1 reference only** (PR #4). NOT live Web Rust analytic conjugate engine | Has mathematically clean constant shift / linear conjugate path under analytic-band and Nyquist constraints, not general nonlinear mapping |
| STFT + phase tracking | **Experimental implemented** (R2.1 offline Python, Rust streaming peak phase estimates) | Measured transient/phase/noise defects; not quality-approved |
| Sinusoidal partial tracking + resynthesis | **Experimental implemented in part** (current Rust peak tracking and oscillator reconstruction) | Does NOT include phase-perfect tracking, noise/residual reconstruction (Issue #5 R2.2 pending) |
| High-resolution time-frequency (chirplet/reassignment/nonuniform) | **NOT implemented** | Research candidate only; arbitrary increased FFT window is not a distinct verified high-resolution analysis architecture |
| Whole-file Fourier transform + frequency relocation | **Offline reference/baseline only** and experimental *framewise* FFT-bin relocation | Current live FFT-bin engine is STFT window-by-window, NOT whole-file Fourier transform; whole-file method is not a selectable live engine |

These are research algorithm **families**, not equivalent to four UI
effect modes. Ring modulation and pitch+frequency shift are effects
that transform component frequencies differently, not replacements for
the five algorithm research paths. No fidelity/CPU winner established.

Current known quantitative unresolved: long-file memory on physical
iPhone; subjective sound of warp→Ring and pitch, crusher aliasing; FFT
CPU budget on iPhone. User informally reported that previous iPhone
version seemed to work; this does NOT verify 600-second worst-case
memory and DSP cost across devices.


## 2026-10-13 generalized frequency-coordinate translation / Issue #25

**Architectural change:** DSP \`engine\` selects *only how the waveform is
analyzed and reconstructed*: (0) peak tracking and oscillator resynthesis,
(1) STFT FFT-bin relocation, both experimental. Frequency inversion, signed
axis translation, #24 rational partial-grid positioning, Ring Mod, and Bit
Crusher are orthogonal transform/effect settings, not DSP algorithm types.
Previous engine codes 2/3 remain as compatibility entry points, not exposed
to users in the Web synthesis-method selector.

The accepted nonlinear Warp coordinate already used:
\`C_p(f;r) = expm1(p*ln(f/r))/p\`, with \`C_0(f;r)=ln(f/r)\`,
where \`r>0\` is a reference Hz. We now apply a separate signed displacement
\`u\` **in the same coordinate** after the existing Warp, not a separate
pitch/frequency branch. Its inverse is:
\`T_{p,u,r}(f)=r*exp(u+ln(f/r))\` for \`p=0\`;
\`T_{1,u,r}(f)=f+u*r\` for \`p=1\`; and
\`r*(1+p*(C_p(f;r)+u))^(1/p)\` for \`0<p<1\` when in the
positive domain. A signed extension beyond the zero boundary is used for
intermediate p, then the existing negative-frequency Reflect/Kill/Fade rule
applies; this continuation is an *experimental definition*, not a unique
mathematical or acoustically transparent choice.

Reference \`r\` here is the user's manual theoretical \`F'=r_pitch*F\`
(HISTORY: avoid conflating coordinate reference \`r\` with pitch ratio).
The source coefficient \`u\` is dimensionless; in log mode the output ratio
is \`e^u\`, in linear mode the shift is \`u*F'\` Hz. Thus the same UI slider
and \`Curvature\` parameter govern both extremes and everything between.

The optional #24 rational harmonic lattice uses \`F'=r_pitch*F\`,
\`H=F'/m\`, \`s=(n/m)*F'\`; when enabled it is applied after Warp and
before the shared generalized-axis move. When the actual source is an
ideal kF series with **no preceding nonlinear warp**, rational results
occupy \`(mk+n)*H\`. If the nonlinear g(f) is active, the precise
number-theoretic relationship need not hold for the rendered audio.
The UI explicitly calls \`T_{p,u,F'}(H)\` a *tracked virtual-root marker*;
a constant-Hz translation changes a marker but does **not** generally
produce a new integer-harmonic common divisor. This is essential to avoid
falsely claiming #24's target-H formula works after arbitrary nonlinear Warp.

On/off Ring Mod is a post-effect independent of the synthesis algorithm,
not a frequency shifter. It adds two sidebands from the already mapped
source; it cannot replace a single-sided constant-Hz shift. Bit Crusher is
also post-FX and independent. AudioWorklet uses
\`warp_stream_set_transform\` on both init and live changes; WAV Worker uses
\`warp_stream_render_f32_axis_ext\` with identical extra FX parameters.
Old C ABI entry points remain available for research compatibility.

Optional reference sine is a **WebAudio oscillator** on a separate
low-volume output path. It plays without uploaded audio, uses a
checkbox and chromatic MIDI-like note slider (MIDI 36–96, 0.01 steps),
computes 440*2^((note−69)/12), and displays nearest note/octave,
cents offset, and exact Hz. This monitor is not processed through Rust
spectral DSP and is not included in exported WAV.

This architecture is a clearer division of the single source of
frequency mapping (Rust) and the audio-host/transport/monitor controls
(WebAudio). Neither the analytic complex modulation method nor the
residual-inclusive reference has been promoted to a certified real-time
DSP algorithm; research in Issue #5/#17 remains open.

## 2026-10-14 frequency pivot, spectral slope, and silence audit (#29)

The shared Rust geometry now defines T(f)=C_p^-1(s*C_p(f;P)+u;P), with C_0(f;P)=ln(f/P) and C_p(f;P)=((f/P)^p-1)/p for p>0. P is an independent pivot in Hz, s is a positive spectral slope, u is the signed axis translation, and p is the existing curvature. For p=0 and s=1 this is uniform pitch ratio exp(u); for p=1 and s=1 it adds u*P Hz; for s!=1 the spacing changes about P. Nonlinear frequency inversion is applied before this operation and can move the chosen pivot.

Confirmed bug: FFT-bin resynthesis formerly discarded negative target frequencies regardless of the Reflect/Kill/Fade setting, and clamped some negative intermediates before mapping. Both FFT-bin and peak engines now share Stream::resolve_zero. Web displays mapping-drop reasons and real AudioWorklet source/output RMS, because the geometrical graph alone cannot confirm that source energy survives peak detection, processing or the Nyquist limit. Live WASM API warp_stream_set_geometry and offline warp_stream_render_f32_geometry_ext use the same Rust code. Browser percentages use 0.005 steps (0.5%), signed shift number field uses 0.05 increments, with 0/1 reset controls. The listening guide shows effective frequency changes, ratios/semitones, source examples, geometric parameters and estimated mute reasons. CI validates 500Hz negative translated to 200Hz in Reflect mode versus Kill for both engines. Audible quality across arbitrary real recordings remains experimental.


## 2026-10-14 — physical slope / zero pivot + user-first display (#31)

Correction to the earlier coordinate-affine model: **slope is now explicitly the multiplier of physical Hz distances**, NOT the exponent/scaling of a logarithmic frequency coordinate. From the shared Rust core, the transformation is:

`h = P + s * (g(f) - P)`;
`f_out = C_p^-1(C_p(h;R) + u;R)`, where `R=F'=rF>0` is an **independent positive reference** for log/linear translation and `P` is the physical pivot, now **0..20000 Hz**. If h is negative, the Rust signed-frequency zero-policy applies; in the linear p=1 case the translation `u*R` is applied even to negative values before Reflect/Kill/Fade. The common Rust export `warp_translate_frequency_controls` is used in the Web graph, and streaming / offline renderers use the same transform.

Thus with Invert=0, P=0, u=0, s=2, any p from 0 to 1 yields 500Hz→1000Hz and 1000Hz→2000Hz. For P>0 the pivot remains fixed when u=0, while changes in s expand/contract physical frequency spacing. When s=1, p=0 maps the shift into uniform ratio exp(u), while p=1 adds constant u*R Hz. Nonlinear inversion and rational pre-layout are orthogonal stages and may change these simple relationships if enabled. The earlier docs describing log-coordinate slope as the operative behavior are now historical, superseded by this definition.

The graph toggles **20Hz..2kHz** or **20Hz..20kHz** by direct tap (square inner plot in both); the main remapped curve has a thin alpha representing wet Mix, and the unchanged-frequency diagonal remains visible representing dry Mix. Exact graphical alpha is a visual mixture cue, **not** an amplitude or a spectrum measurement. Editing numbers is done inline at the slider readout, including numeric harmonic parameters and sine Hz/cents; duplicate extra numeric fields are removed. The frequent panel shows only concise perceptual 500Hz mapping/semitones and live output state; equations and engine diagnostics remain discoverable in the expanded area. This implements UI/UX source '利用者起点' UX-04,05,06,07,09,11 without adding new prose walls.

Mobile background audio uses the browser Media Session API for system controls and an optional WebAudio MediaStreamDestination→HTMLMediaElement bridge, with ordinary WebAudio fallback if HTML playback is refused. This **may** improve eligible browser background playback and lock-screen controls, but true iOS suspended-tab/locked-screen audio processing cannot be guaranteed by Chrome headless tests and must be verified on a real iPhone. The app does not falsely claim unconditional OS background execution.

## 2026-10-14 Web DSP/UI update (#33)

Engine B (STFT FFT-bin relocation) is the initial Web selection following the user's positive operating results; this is not formal acoustic-quality certification. Engine A remains an experimental sinusoidal-peak-tracking/oscillator-resynthesis method, not an implementation of Goodhertz Lossy's codec-degradation processing. A-only native/WASM controls set the minimum extracted peak frequency (20–20000Hz) and a 0–100% short, three-feedback-delay synthesis reverb, allocated once per Stream creation. Engine B ignores those settings. The same Rust parameters drive realtime Worklet through warp_stream_set_a_options and WAV export through warp_stream_render_f32_a_ext; existing compatibility export remains.

The pivot through nonlinear inversion g is now held at P using P+s*(g(f)-g(P)), unless separate translation u is nonzero. Optional rational grid shift is not canceled when deriving g(P). The compact UI uses a combined two-thumb L/H control and colocates Ring carrier/link and bitcrusher beneath the transform. Harmonic formulas use native MathML separate from a variable/value table, rounded to at most two decimals. The standard for these changes is the user-provided 586-line 利用者起点 UI/UX document (UX-04/05/06/07/09/11). iPhone hardware usability and perceptual reverb sound quality are not certified by CI.


## Issue #41 / PR #42: A peak neighborhood and selectable UI semantics
The existing Engine A uses one local FFT maximum per tracked sinusoidal partial and discards most unmatched residual energy; **frequency-floor alone is not a noise/residual reconstruction algorithm**. The additional independent 1–8 FFT-bin peak-neighborhood selection suppresses weaker nearby maxima. The previous selection is exactly `1`; larger values are experimental and may sacrifice closely spaced partials. No additional allocation occurs in the A render loop.
The initial #41 automatic engine selection inspected only the raw nonlinear warp, causing a contradiction when post-warp axis translation or signed-frequency Reflect changed the audible/visible slope. Issue #43 fixes it: automatic selection samples the *final audible in-band main curve* using canonical Rust/WASM mapping and axis-translation exports, with rational translation, signed 0Hz handling, quality-specific Fade and Nyquist clipping reflected in the UI mapping. It evaluates the least-squares overall trend; a local fold kink alone does not force A. Post-effect Ring Mod sidebands and display-only logarithmic presentation are excluded from the engine decision. AudioWorklet and offline worker apply A peak-band through shared Rust controls; the legacy C/WASM ABI remains callable with band=1 defaults.
This entry describes the PR #42 implementation and its audio/ABI boundaries, not independent R2.2 acceptance. CI/review and publication evidence are maintained in Issue #41 and PR #42.


## 2026-10-14 — signed physical slope and contextual control help (#72)

The physical slope parameter `s` is now accepted in **[-4, 4]**, including 0. This modifies the existing anchored transform `h = P + s * (g(f)-g(P))`; the separate signed coordinate translation `u` follows as before. Positive `s` keeps direction, zero converges the band around the pivot (and may change DC/Nyquist acceptance), and negative `s` reverses frequency ordering about the pivot. Signed targets below 0Hz use the existing negative-target reflection/zero-boundary processing. Native ABI, WebAssembly, live AudioWorklet, WAV export and graph use the shared Rust code; no JavaScript-only sound mapping has been introduced.

For reflection synthesis/attenuation, the directional classification evaluates **the fully mapped physical curve**, not just the pre-slope warp: negative slope reverses an otherwise ascending segment, while two direction reversals can cancel. Reflected-branch distance in the negative-slope case is measured against the translated configured pivot; pre-existing Fold/Reciprocal reflection references remain available.

The Web selector **no longer offers legacy Blend/simple interpolation**. Geometric Reciprocal is the initial/reset default; Fold L/H remain. The old Blend Rust enum/C ABI mapping stays for compatibility and historical tests.

Primary UI rows show short labels, editable current values with units, and on-demand `ⓘ` descriptions accessible by tap/click/keyboard. Extended formula, aliasing, route and crusher notes are not permanently displayed. This follows the shared .ai-guidelines UX-06/07/11/12 and other repository precedents gathered in #72. Simplified presentation does not remove real DSP diagnostic data; independently tested touch/iPhone acoustic acceptance is still pending #62.

## 2026-10-14 — correction: true reflection branches and near-zero positive input (#75)

**Behavioral correction (supersedes #72's descending-derivative classification):** A negative *physical slope* or Reciprocal full inversion may produce a descending frequency mapping with **no hinge/reflection event**. Do not attenuate that audio as a reflected component. The shared Rust `reflection::distance` applies C/D only when (a) input lies on the reflected side of a true FoldHigh/FoldLow hinge defined by `fold_frequency`, with distance measured from the final mapped hinge, or (b) the final signed frequency is negative (0Hz boundary crossing, distance `-f'`). Mere sign of `df'/df` is irrelevant; a negative slope must neither create nor suppress a finite-band Fold event. The folded and 0Hz distances contribute once each to a single shared gain law, preserving live/WAV/graph parity.
    
The positive lower mapping bound and Web controls extend to **L=0.001Hz**, excluding 0 exactly. The existing logarithmic coordinate uses `ln(f/L)` and remains well-defined at positive L; it cannot handle L=0. The change does **not** introduce a DC spectral oscillator or overcome the FFT bin/window frequency resolution. Engine A's selected floor may be lowered as well, but its finite resolution remains. Default L and Engine A floor still equal 20Hz, and reference F/pivot/display graph are independently defined.
