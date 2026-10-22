## M2/M3 incremental integer-count migration — PR #296 / Issue #295 (in review)

The harmonic denominator m (1..64, default 4), signed numerator n (-128..128, default -3) and harmonic index q (1..32, default 1) use shared `mountIntegerParameterField` over their existing `createParameterBinding` descriptor when this PR is accepted. This does **not** add a pitch or percent view: there is no user-authorized semantic need for those count conversions. The intrinsic integer number editor and integer slider retain the existing appearance; their input, slider, capture/restore and math must agree on one accepted integer value. Empty/incomplete number text cannot change the canonical integer, and a valid new number generates at most one application event. Reset and A/B restores are silent, while readouts and derived H/P always use canonical integers rather than the in-progress raw DOM text.

Acceptance: Node fake-input and Chrome actual-browser negative regression; same-head Rust/WASM/AudioWorklet/Offline, formal Review and existing Pages entry. This is a bounded slice of #79, not completion of the separate nonlinear coordinate u or other remaining `app.mjs::state.precise` migrations.

## Current contract: default unit-sensitive snap and per-instance overrides (#293; 2026-10-22)

The later default-ON user decision in section 16 supersedes earlier staged text that described opt-in/OFF snapping. **Default application behavior** in shared Web parameter bindings:

- During a slider gesture with the current view **♪ note**, nearby 12-TET semitones snap with a 6px physical-rail threshold; in **% rail view**, nearby **integer rail-travel percentages** snap at a 1% step and 6px threshold, *not at an integer number of Hz*. The source rail's continuous inverse defines the physical value, including nonlinear rails. Other view modes preserve the explicitly configured legacy descriptor snap (e.g., ratio semitone or signed slope anchor targets). A consumer with no legacy snap can still obtain the note/% defaults.
- Snapping starts **ON for the user interface**, the context/long-press/keyboard menu toggles it per parameter, Alt/Ctrl temporarily bypasses it during a gesture, and Reset restores that consumer's configured default. Standard fields and the specialized virtual-root F/H unit-switch controls use the **same** `attachParameterSnapControls` interaction helper. No separate bespoke menu.
- A parameter can override or disable one active unit's grid with `defineParameter({..., snapByUnit:{percent:{unit:"percent",mode:"step",step:5,thresholdPx:6},note:false}})`; ordinary `snap` remains the default/fallback for other units and the pure `snappedValue` legacy signature. The Web mounting adapter accepts `snapEnabledDefault` when a concrete consumer has a different approved preference. Special rails may specify `snapByUnit:{hz:false}` to retain an unsnapped integer-Hz gesture.
- **Typed text (including fractional percent and cents), unit selection, forced constraints, silent linked parameters and display rounding never apply gesture snapping by default.** Numeric Float64 remains canonical. Physical rail endpoints are not replaced by nearby music targets.
- Scope: Web UI and common binding only. VST3 IDs, Rust DSP, and native host parameter semantics are unchanged. Physical iPhone verification is separate from Chrome/Pages machine acceptance.

# Frequency Warp — Common numeric parameter and unit contract (#77 / #79)

## Current accepted Web state — 2026-10-21 (supersedes earlier staged notes)

The Web source uses `web-demo/parameter-units.mjs` as the dimensional codec, `parameter-binding.mjs` for canonical Float64 value/unit ownership, and `frequency-unit-field.mjs` for the common input/UI adapters. [PR #287](https://github.com/kinoko34077/frequency-warp-vst/pull/287) integrated virtual-root F/H into the canonical binding and introduced a [capability/API catalog](CAPABILITY_API_CATALOG.md) plus structural negative tests. [PR #288](https://github.com/kinoko34077/frequency-warp-vst/pull/288) standardized the actual unit-icon component. [PR #289](https://github.com/kinoko34077/frequency-warp-vst/pull/289) standardized Wet, A-reverb, zero-reflect, zero-decay and invert's typed percent-input lifecycle via `mountPercentParameterField`, retaining their separate DSP/WebAudio callbacks.

**Verified release:** exact main `769727696168fe62d62bd14abce0bb8c94111030`; [Browser/Rust/WASM/Chrome](https://github.com/kinoko34077/frequency-warp-vst/actions/runs/39515770022), [offline](https://github.com/kinoko34077/frequency-warp-vst/actions/runs/39515769602), [Pages/public entry](https://github.com/kinoko34077/frequency-warp-vst/actions/runs/39515769407) all SUCCESS. The implementation is **still partial overall**: #79's M2 coordinate/count families and M3 remaining legacy `state.precise`/panel state consolidation remain OPEN. No browser CI, public Pages verification, or unit-notation change proves real iPhone Safari or native DAW automation.

**Read order for agents:** [repo capability/API catalog](CAPABILITY_API_CATALOG.md) → the owning source API and tests → this specification's current/superseding requirements → older dated milestone history only when relevant. Sections below include historical phrases such as "not yet wired" and "staged/unmerged"; those claims describe the state **at that milestone**, not current public main. Reuse the established API instead of implementing a semantically identical control, unless a documented purpose-specific adapter is genuinely required.

# Frequency Warp — Common numeric parameter and unit contract (historical #77 outline)

Status (2026-10-15): **partial implementation**. Shared pure codec and M1 frequency bindings, compact three-icon UI and semitone/cents subunit controls are implemented in the Web release changes recorded by PRs #184/#185/#186. Verify the target main/Pages state before claiming a particular deployment; CI success alone is not a physical iOS test. M2 dimension migration and M3 legacy state consolidation remain open under #79; browser unit changes do not authorize native DAW automation.

## 1. Separate five layers

1. **Canonical DSP value:** Float64 numeric parameter used by Rust/WASM AudioWorklet, graph, offline WAV. Do not change native ABI or re-scale it when changing display units.
2. **Parameter descriptor:** stable id; dimension (frequency / positive ratio / signed ratio / fraction / coordinate / integer); canonical unit/range; default; dependencies; slider transfer function and allowed output views.
3. **View codec:** loss-aware parse/format for % (position along the exact parameter's rail), physical Hz, 12-TET note + cents, ratio or relative semitones/cents. This must not silently reinterpret an invert fraction as Hz.
4. **Interaction:** draggable coarse slider, fine typed input, optional chained dependencies, precision and undo, accessible labels. The single canonical state is changed once per interaction.
5. **Derived audio & display:** Rust native/WASM audio/live WAV and graph receive canonical numbers; descriptive text only reads derived values. User change of output *notation* never triggers DSP recomputation.

## 2. Unit / dimension compatibility

| Dimension | Parameters | Meaningful representations |
|---|---|---|
| Positive/zero-allowed absolute Hz | L/H, carrier, pivot P, F, A floor, reference tone | Hz; musical name + cents for **positive** values; rail travel % |
| Positive relative ratio | r | Ratio; semitones; cents from unison; rail % |
| Signed physical stretch | slope s | Signed ratio multiplier / signed rail%; a Hz or absolute note is **not** equivalent |
| Fraction / amplitude | invert, synthesis C, reflection D, Wet, reverb, quality | Percent; never Hz / note |
| Coordinate displacement | move u | Raw coordinate u; rail %; Hz when p=1 via Δf=uR; ratio when p=0 via exp(u); middle-p inverse mapping requires positive reference |
| Integer / count | FFT or peaks / denominator m / numerator n / harmonic index q / bits | Integer, sometimes rail%; no physical pitch substitution |

When p∈(0,1), `u` is a nonlinear generalized coordinate. A globally valid constant-Hz label is **not** available. Musical pitch and cents are meaningful for a positive base frequency or dimensionless ratio, not arbitrary percentages. At 0Hz there is no octave/note representation; the selected note unit stays selected while its value is displayed as unavailable (—), not reset to Hz. Music note parses use A4=440Hz by default and can be configured later; output precision does not change the stored Float64 canonical value. For 0.001Hz, numerical pitch formatting is possible but FFT resolution/audio audibility is not implied.

## 3. First implementation / opt-in semantic link

`H=rF/m`; user-facing chain `🔗 H ↔ 起点 P` links these two exact quantities, independent of the existing carrier/Fold-link checkbox.
- **OFF:** mathematical virtual H remains calculated; physical pivot P follows only the existing independent slider/number.
- **ON:** changing F, m or r recalculates H and sets canonical P. Changing the pivot P calculates F=mP/r, clamps F to its expanded theoretical 0.001–5,120,000Hz range and publishes the actual realizable H as P. A clamp cannot silently leave inconsistent equal sign.
- `n` and `q` remain their existing distinct virtual arithmetic values; activating H–P does **not** secretly enable Rational Layout, Ring Mod or change the inversion progression.
- The source event is dispatched once. Link-induced updates modify the peer state silently before the existing single render/update callback. No recursive DOM `input` dispatch and no feedback loop. Reset disables the opt-in link; the existing carrier-chain state is not modified.
- Axis pivot's rail now resolves 0 independently, then positive frequencies 0.001..20..20000Hz, permitting a small virtual H without a false forced 20Hz pivot. Existing direct numeric input retains 0.001Hz precision; default P=350Hz.

The marker shown beside `変換形状` is a **Fold L/H hinge** only in Fold modes and a **fixed inversion reference** in Reciprocal, labeled accordingly. The visible marker is intentionally separated from the optional explanatory `ⓘ` popover.

## 4. Possible optional second link: Δ to move u (not implemented)

`Δ = n rF/m = nH`, `R=rF>0`; for p=1, `u=Δ/R=n/m`. For p=0 the value that gives `R+Δ` at reference frequency is `u=ln(1+Δ/R)` **only when** `1+Δ/R>0`; p∈(0,1) requires the common nonlinear inverse coordinate, and signed zero-crossing is not uniformly expressible as the same positive-frequency pitch movement. The slider's existing bounded u∈[-2,2] can also reject desired Δ. **Therefore no automatic Δ→u link or claim of universal equivalence is shipped.** A future opt-in link must explicitly choose reference and behavior on missing/negative/incompatible solutions, and test direction/cancellation against the Rust oracle rather than approximate JavaScript-only audio mapping.

## 5. Migration gates

- M0: shared codec and typed unit matrix with Node tests (this PR). No audible/DSP modifications from view choice.
- M1: accepted in part; use a `ParamBinding` object for selected frequency controls (L/H/P/F/carrier/A floor). Unit dropdown next to typed input; Hz↔note+cents↔rail %; preserve exact Float64 canonical state and existing dual-thumb pointers.
- M2: adopt r, signed slope, u and fraction/integer controls with correct compatible modes; for u require explicit p and reference, no fake absolute-Hz for intermediate p.
- M3: replace duplicate `state.precise`, `preciseFields`, sine input glue one parameter at a time; regression for bidirectional updates, clamped typed input, empty/invalid edits, focus blur, reset, roundtrip and Undo (if added), 390px iOS touch, AudioWorklet/WAV/graph parity. Avoid simultaneous bulk replacement without independent CI.
- M4: only if tests confirm M1–M3, consider a common customizable pitch display mode and saved user preferences. No connection to unrelated repositories is implied.

## Out of scope

VST3 host wrapper not built. Real iPhone background playback and subjective audio quality are separate issues. The codec is a representation/math building block, **not** a promise that arbitrary spectral transformations are equivalent to a scalar MIDI transposition or that all numeric controls accept every unit.

## 6. Declarative unit registry / parameter binding / snapping (#79)

The opt-in implementation foundation is `web-demo/parameter-binding.mjs` with pure Node tests. It is not yet wired to the existing Web control DOM or the VST3 editor, so it does **not** claim public unit menus or enabled snap UI.

### Authority and ownership
- **Unit registry** owns name, physical dimension/meaning and interpretation rules; `parameter-units.mjs` remains the existing single mathematical parser/formatter for Hz/note/cent/ratio/%.
- **Parameter descriptor** owns an existing stable id, canonical numeric min/max/default, allowed subset of typed units, precision, optional exact rail transfer and optional snap policy. A unit **must not** globally own every control's range.
- **Binding instance** owns one full-precision Float64 canonical value and the currently selected notation. `selectUnit` changes only the notation, without rewriting the canonical number or notifying DSP. `setView`, `setPosition`, `setCanonical` and `reset` validate and update the same value.
- **Interaction boundary** owns DOM update/render scheduling. `notify:false` is available for link-derived silent peer updates. Callback reentrancy is explicitly rejected; no artificial DOM input events.
- **Host integration boundary** remains separate. The VST3 host's already-assigned parameter IDs and canonical physical semantics in `vst3/PARAMETER_AUTOMATION.md` remain unchanged. Display units and snapping must not be represented as new host parameters without a distinct host-interface decision.

### Snap semantics
A snap declaration is `{enabled:true, unit:"note", mode:"step", step:1, origin:0, thresholdPx:6, during:["slider"]}` or `{enabled:true, unit:"hz", mode:"targets", targets:[440,880], thresholdPx:6}`. The snap unit must belong to the **parameter's allowed unit set**. Numeric limits, range presets and snap targets are parameter metadata, not globally fixed unit defaults.

- `note` step 1 means the existing A4=440Hz twelve-tone semitone grid; `cents` and `semitones` mean interval offsets on *positive* ratios. Signed slope does not acquire a musical-note interpretation.
- `percent` always means position on the **actual rail**, including nonlinear transfer. A physical frequency's 50% travel must not be confused with half its Hz value.
- Project each candidate onto the physical rail and select the closest one by **pixel distance**. Snap applies only at or within `thresholdPx` of a candidate; `railPixels` must be passed by the UI. This avoids abrupt changes in apparent grab radius along logarithmic rails.
- Default snap applies to slider operations, not typed edits. Opt-in `during:["slider","typed"]` can enable snap for typed edits. Suppressing snap does not prevent clamp/reject validation.
- 0Hz has no musical-note representation; note conversion/display for zero fails explicitly. A future UI must offer a clear fallback to Hz at zero rather than silently displaying a fictitious pitch.
- Format precision does not quantize the stored Float64. The rail supplied to binding must be the reversible **continuous** parameter transfer, not a rounded integer thumb-position helper.

### Example (illustrative descriptor, not live defaults)
```js
const fundamental = defineParameter({
  id: "fundamental",
  min: 20, max: 2000, defaultValue: 350,
  units: ["hz", "note", "percent"],
  rail: {toPosition: hzToNormalizedRail, fromPosition: normalizedRailToHz},
  digits: 3,
  snap: {enabled: true, mode: "step", unit: "note",
         step: 1, thresholdPx: 6, during: ["slider"]}
});
const binding = createParameterBinding(fundamental, {onChange: onOneDspValueChange});
// binding.selectUnit("note") leaves canonical DSP value unchanged
// binding.setPosition(position01, {railPixels: sliderWidthPx})
```

### Acceptance status & next migration
This pure-layer foundation is independent of the existing `app.mjs` / `harmonics-panel.mjs` form glue; existing UI remains unchanged. The next #79 M1 PR should wire one frequency control end-to-end (Hz/note+cents/rail percent; touch, keyboard, zero-Hz handling and link semantics) before migrating more controls. M2 subsequently covers ratio, signed slope, counts, fractions and coordinate constraints. M3 retires redundant `state.precise` and panel fields only after passing sound/graph/WAV parity and exact-main Pages checks. No migration to VST3 audio or external engine ABI is implied.

## 7. M1 first Web UI slice — L input (stacked on #113)

**Scope and status:** #79 branch integration only, not yet merged/released to the public Pages main. The first parameter is band lower-bound L (`low`) with Hz / note+cents / nonlinear physical rail%, plus opt-in semitone snapping.

- L now uses one `createParameterBinding` canonical Hz `number` instead of `state.precise.low`; the pre-existing hidden `#low` range is only an integer gesture/thumb transport and is not the DSP authority. Other parameters retain their existing adapters until independently migrated.
- The actual piecewise log rail is [0..0.2] for 0.001..20 Hz and [0.2..1] for 20..20000 Hz. Percent means 100×this position. Continuous inverse is used for value input; rounding to 1000 coarse thumb steps never overwrites typed canonical values.
- Unit selection only reformats the current value: no DSP change event. Typing a complete valid note (`A4+25c`) or a valid Hz/% number commits once, updates coarse rail position, then uses the existing `updateParams` Rust/graph pipeline. Invalid/incomplete edits preserve the last canonical value and revert on blur/change. Normal display digits follow the existing display setting; focus reveals high precision.
- Optional snap is **OFF by default** and only for slider gestures: note step=1 semitone, threshold=6 physical rail px. The existing two-thumb touch, mouse and keyboard input handler still emits native `input` for the same hidden source control, then this binding applies snap before the single DSP update.
- Constraint-induced adjustments when L/H or sample-rate cap collide silently synchronize the canonical binding and its coarse thumb (rather than showing a note label disagreeing with effective audio bounds). Reset returns L to 20Hz, Hz notation, snapping OFF.
- `web-demo/parameter-unit-browser.test.mjs` exercises actual staged artifact in headless Chrome at 390px: parse/format, precision retention, true nonlinear %, invalid input rollback, optional snapping, keyboard thumb and reset. The existing Rust AudioWorklet/WAV/graph code and VST3 parameter IDs are unchanged.
- **Acceptance gate:** exact head CI and review before further horizontal migration. M1 is not the full per-control unit rollout; #79 stays open.

## 8. M1 upper H reuse (#79, staged, NOT released)

Upper band H (`high`) reuses the same `mountFrequencyUnitField` / `defineParameter` / 6px opt-in semitone-snap path as lower band L, with canonical default H=16000Hz. Its own `#high-unit`, `#high-snap`, text input and accessible dual-thumb readout are independent of L unit/view state. Normalized rail travel is the same existing piecewise logarithmic 0.001..20..20000Hz mapping; read-only unit switching does not change the Rust/WASM controls.

The shared `bounds()` logic still owns L/H separation and effective sample-rate caps; if moving one bound changes the other, its canonical binding and slider are silently updated before the single render/graph notification. H is not a globally fixed 20000Hz oscillator if a file sample rate limits the effective processing band. All original graph/AudioWorklet/WAV calls remain unchanged.

Historical milestone acceptance included Chrome 390px note+cent roundtrip, rail-percent correctness, invalid H input rollback, snapped 880Hz, screen-reader thumb text, and Rust/WASM regression. This paragraph described a then-unmerged stacked Draft; consult PR #186 and the current main/Pages actions for actual released state. Other unit families remain #79 work.

## 9. M1 pivot P: explicit zero-Hz, positive rail, and H↔P link (staged #79)

Pivot `axis-pivot` is an independent canonical frequency binding (default 350 Hz). The physical slider has an **exact zero** at rail position 0 and the strictly positive mapping from 0.001Hz to 20kHz at positions 1..1000. The continuous unit-% codec uses that exact piecewise function; a positive percent smaller than the first representable discrete slider step resolves to 0.001Hz, not a fictional intermediate negative/zero musical pitch. This single discontinuous special point cannot have an everywhere one-to-one inverse.

- Pitch notation is available only when P>0. Selecting note at P=0 restores Hz without updating any DSP value; dragging a note-displayed P down to 0 also automatically changes its display to Hz.
- Switching Hz/note+cents/rail% does not emit DSP parameters and does not round the canonical value. Opt-in semitone snapping is 6px on actual slider width.
- Existing `H=rF/m ↔ P` opt-in link remains the only coupled semantic relationship: H update sets the **same** pivot binding silently, and editing P solves `F=mP/r`, clamps F to its fixed range, and silently commits realized H as P before the established single `updateParams`. OFF keeps P independent. Reset turns link and snap OFF, chooses Hz and restores P=350.
- This migration removes the duplicate `state.precise["axis-pivot"]` UI handler; the old range remains an approximate DOM gesture transport. Native VST3 ParamID 7 remains the original canonical Hz.
- 390px Chrome regression verifies note parse, nonlinear percent, 0Hz fallback, forward/reverse H link and reset; existing Rust/WASM streaming/graph/WAV test stays the audio oracle.

This is a staged child PR, not yet published to GitHub Pages.

## 10. M1 Engine A minimum frequency (staged)

The existing `a-min` parameter (minimum positive extraction frequency for Engine A) reuses the Hz/note+cents/nonlinear physical rail% typed binding and 6px opt-in semitone snapping. Canonical bounds are 0.001..20000Hz, default 20Hz, and no arbitrary zero-Hz musical note is accepted. Its own unit/snap preference is independent of L/H/P. The underlying Rust Engine A frequency gate receives the canonical `aMinHz`; changing only formatting does not retrigger audio.

The original `#a-min` range remains a coarse DOM gesture transport; duplicate `state.precise["a-min"]` and old numeric field listener are removed. Reset restores 20Hz, Hz notation, snap off. The mobile staged Chrome test must first select actual Engine A in Settings, then verify visible field/menu, cents, nonlinear rail%, invalid edit retention, snapped 440Hz and reset. Other M1 controls F/carrier/reference sine remain open.

## 11. M1 harmonic source F (staged, not released)

The harmonic source F `fundamental` (20..2000Hz, default 350) now has one `mountFrequencyUnitField` canonical Float64 owner inside `harmonics-panel.mjs`. The panel's legacy `preciseFields["fundamental"]` numeric listener and range owner are bypassed (other harmonic inputs unchanged). `harmonicParameters()` reads this one binding, and the existing `setFundamentalFromPivot(P)` writes back into it silently rather than creating a second independent F. The external Rust/DSP graph, native VST3 ParamID 19 and mathematical invariant `H=rF/m` remain unchanged.

Unlike L/H/P, the existing F slider is LINEAR 20..2000Hz; thus F percent denotes `100 (F-20)/1980`. Note+cents and Hz use the same shared physical converters; opt-in 6px semitone snapping applies to the F slider only. F unit selection cannot trigger DAW or DSP automation. Existing global display precision remains formatting only and F input focus preserves the full canonical value.

Staged Chrome regression must visit the actual mathematical panel, parse A4+25c, verify **linear** rail%, preserve F during notation changes, confirm H↔P from precise F, snap A4=440, and reject invalid text without changing canonical F. Existing P↔F inverse regression continues. Carrier/Fold remain distinct. No Pages release or main merge.

## 12. M1 manual ring carrier c (staged in same harmonic-panel PR as F)

Manual carrier `carrier` is now one `createParameterBinding` canonical Hz number, with Hz / note+cents / rail% and opt-in semitone snap. The existing carrier `0` rail position is an exact special 0Hz; positive native rail positions 1..1000 cover **1..20000Hz logarithmically**. The existing manual typed input may specify 0<Hz<1 independently of that coarse rail (positive values below 1Hz all display at the first positive rail position, without quantizing their canonical Hz unless an actual slider edit occurs). Note mode cannot represent 0Hz and automatically falls back to Hz.

The independently opt-in `carrier-link` in a Fold L/H mode still overrides only the **effective** DSP carrier with the computed fold frequency; manual `carrier` remains stored unchanged so switching OFF recovers the previous manual carrier. While linked in a valid Fold mode, manual carrier input, range, unit select and snapping are disabled together. This link remains separate from H↔P; unit selectors do not silently change either link mode. No VST3 ParamID 14/15 or Rust DSP ABI changes.

Staged Chrome acceptance includes visible Ring controls, exact note→Hz roundtrip, existing log+zero rail%, 0Hz note fallback, independent fold link disable/restore, and existing dual-thumb, graph/live/WAV regressions. Reference sine remains the final browser-only M1 frequency control.

## 13. M1 browser-only reference sine (staged; completes proposed frequency *coverage*)

The reference sine is a **monitoring oscillator, not a Frequency Warp DSP/VST3 parameter**. `sine-hz` becomes the one canonical Float64 frequency shared by the oscillator, note+cents and the MIDI36..96 physical rail. The old independent `state.sineExactPitch` authority is removed. The existing `#sine-pitch` slider remains the control transport at its original **0.01 semitone** step, and `#sine-cent` is an additional view/editor that commits Hz into this same canonical value (it must not create a competing cents or MIDI owner).

- Canonical range is `440*2^((36-69)/12)` to `440*2^((96-69)/12)` Hz; the formerly displayed 65..2100Hz typed bounds were already effectively clamped by the MIDI range. Default 440Hz.
- Hz / note+cents / **MIDI rail travel%** uses `m=69+12log2(f/440)`, `position=(m-36)/60`. This rail is not linear in Hz, and should not be confused with absolute cent-percentage.
- Optional snap-to-integer-semitones uses the same 6px physical track radius, OFF by default. The shared coarse thumb sync must respect the actual native range step (`0.01`) rather than rounding to integer MIDI notes; neither thumb rendering nor view formatting may quantize the canonical Hz.
- Existing oscillator frequency ramp `setTargetAtTime` consumes that exact canonical Hz, with the same `updateSineLabel` graph/label refresh and note/cents input semantics.
- This is strictly Web-only, with no VST3 ParamID or .fwengine ABI change. Exact-head Chrome at 390px must verify A4+25c, MIDI rail%, cents editor, .01 gesture step, invalid text rollback, snap 440Hz and no failures in the pre-existing Rust/WASM/graph tests.

M1 still requires consolidated integration review, safety/compatibility audit, and actual public Web unit menus deployment before claiming the full user-visible migration DONE. M2/M3 for ratio/slope/coordinate/percentage/count inputs remain separate.

## 14. M2 ratio r: dimensionless interval views (staged child PR)

The positive pitch ratio `pitch-ratio` (r) is the first M2 non-Hz migration. Its single full-precision canonical value remains a **dimensionless multiplier** `0.25 ≤ r ≤ 4`, default `1`. It now uses the shared `mountParameterUnitField` adapter (with the legacy frequency export kept as a compatibility alias) instead of its own `preciseFields["pitch-ratio"]` numeric/range listener.

- Compatible units are `ratio` (× multiplier), `semitones` (12 log₂ r), `cents` (1200 log₂ r), and `percent` (100 × (r−0.25)/3.75). These are **interval representations**, not absolute musical note names or frequencies.
- The physical r slider remains its original linear 0.25..4 range, step 0.05. A unit switch is display-only; a typed interval/ratio commits exact Float64, while the slider is an approximate gesture proxy. Snapping is an opt-in, 6px distance to the nearest integer-semitone ratio, not a percentage-of-Hz.
- `harmonicParameters()` and both link directions `H=rF/m` and `F=mP/r` read the same canonical r. Invalid inputs preserve the last accepted ratio and never silently turn r into 0.
- The effect settings reset explicitly resets r to 1, ratio notation, snap OFF. All other harmonic controls retain their existing adapters.
- Staged Chrome at 390px verifies +7 semitones ↔ 2^(7/12), 700 cents, real r-rail percent, linked P update, opt-in snap and reset. Rust/WASM/graph/audio parity remains mandatory, and this does not modify VST3 ParamIDs/engine ABI.

Other M2 control families (fractional percentages, counts and coordinate u) remain future independently bounded migrations. The historical Draft at that stage was not publicly deployed; consult the current main and Pages Actions for present deployment.

## 15. M2 signed slope s: negative/zero allowed, no musical interpretation

The signed slope `axis-slope` retains its established canonical `-4 ≤ s ≤ 4`, default +1 and original linear slider step 0.01. This is a **signed scale / orientation** of the frequency-coordinate mapping: negative s reflects ordering and zero collapses to the pivot; do not convert s to Hz, an absolute pitch, cents or semitones. The allowed view subset is `ratio` (signed multiplier) and the **physical rail position** `percent = 100(s+4)/8`.

Its value now lives in the same dimension-neutral Float64 binding as the positive ratio r, but the signed scope is a *different parameter descriptor* and explicitly retains negative and zero values. The old separate `state.precise["axis-slope"]` number/range listener is bypassed. Selection changes do not send DSP updates. Optional snapping to specific **scale anchor targets -1, 0 and +1** uses actual physical pixel distance (6px threshold) rather than an interval/semitone grid. Both normal slider changes and the existing `1へ` button drive the same canonical binding, without reentrant DOM events.

Settings reset restores s=1, signed multiplier view and snap OFF. Staged Chrome at 390px verifies s=+1→62.5% rail; 25%→s=-2; typed -1.25 full-precision; snap to -1/0/+1; musical note names invalid; original reset button parity. This does not alter the Rust DSP/native host interface.

Other M2 classes such as fractions/counts and the coordinate u remain unmodified.

## 16. M1/M2 user-facing snap interaction and cents precision display (2026-10-15)

The latest explicit UI decision supersedes prior statements in this document that snap is opt-in/OFF by default. All nine existing bound units **default snap ON** and reset ON, with no visible snap checkbox or permanent indicator. Snapping still affects **slider gesture only**, within each descriptor's 6px real physical rail threshold, never numeric typing, unit selection or silent linked updates. The existing stable Hz/ratio/slope and DSP parameter identities are unchanged.

- **Context toggle:** right-click, touch/pen long-press (~550ms) or keyboard Shift+F10 / ContextMenu key on a parameter range/dual thumb, value field or unit menu opens one transient menu for that parameter. The menu item switches persistent-for-the-current-page snap ON/OFF, without touching canonical numeric values. Touch hold is canceled on movement >10px, pointerup/cancel or scroll. There is no hidden checkbox retained in the source DOM.
- **Temporary precision modifier:** while **Alt or Ctrl is held**, slider operations bypass snap (both single ranges and L/H dual thumbs), without switching the stored ON preference. Releasing the modifier returns to default snap behavior. Keyboard/window focus transitions clear stale modifiers.
- **Integer cent display:** visible twelve-tone note labels (`A4+25c` etc.), interval cents field (`pitch-ratio`) and the reference sine's separate `sine-cent` readout show **zero decimal places**. User input such as `A4+25.375c` or `700.375` cents is still valid, and canonical Float64 values retain the fractional difference; switching representations, focus/blur and formatting must never feed rounded text back to DSP.
- **Layout inspector compatibility:** its opt-in right-click / touch-hold element menu ignores recognized parameter snap controls, while keeping normal inspector interactions for all other elements. In the settings modal the menu must render within the top-layer dialog. Existing graph/AudioWorklet/WAV processing stays unchanged.
- **Acceptance:** actual staged 390px Chrome DOM checks no visible snap buttons; default/reset ON; menu right-click, touch-hold, Shift+F10; Ctrl+Alt transient bypass, fractional-cent typed precision; snap value and sample-rate links unchanged; explicit inspector coexistence, Rust/WASM, offline, exact-main Pages and live-public checks before publication.

Other unimplemented M2 dimension families and M3 state cleanup remain open.

## 17. Web unit audit — canonical L/H and complete effect reset (2026-10-15)

The earlier staged `bounds(changed)` implementation in `app.mjs` computed the physical 6%-gap/8%-correction but then reloaded stale `ParamBinding` canonical numbers from `scalar()`. At a violating pair L=15,500 Hz / H=16,000 Hz, editing L must move **canonical H** to 16,740 Hz (8% headroom) and a subsequent graph/settings pass must not revise L. The accepted `frequency-bounds.mjs` pure resolver is the single owner of these physical constraints; its canonical outputs are committed to each binding before coarse range/thumb positioning. 2,500 randomized min/cap/origin pair tests and actual 390px browser edits, precision-view redraw and reset regression protect the fix.

The Settings `エフェクト設定を初期値へ戻す` action also restores *all bound effect parameters*, not just the ratio r. It now resets harmonic F=350 Hz, manual carrier c=350 Hz, r=1; integers m=4/n=−3/q=1 together with their visible slider positions and previous `preciseFields` aliases; and disables the Fold carrier-link and H⇔pivot link. Per-control unit view and snap ON are restored on the eight effect unit bindings. The independent WebAudio sine oscillator keeps its actual frequency and playback status but its **snap preference returns ON** as a user-interface default; no automatic oscillator restart occurs. File choice and playhead remain preserved.

The global reset is a single user action: do not dispatch synthetic input events for each parameter, and do not change native VST3/DAW ParamIDs. Real Chrome regression deliberately sets conflicting pre-reset numeric, unit view, snap OFF and carrier link, then asserts exact reset across controls.

The remaining M2 fractions/u/count and M3 legacy state migration are future tasks, not accepted by these two audit fixes.

## 2026-10-15 effective audio domain (superseding older draft assumptions)

A theoretical harmonic model may accept F up to 5.12MHz (and graph may display down to 0.001Hz); this is **not** the active DSP passband. The user's current rule defers >20kHz to possible later oversampling. Shared Rust currently validates effective axisReference R in [1,20000]Hz and |shiftHz|<=20000Hz even if rationalEnabled is OFF. Web preflight must reject incompatible *audio application* visibly, preserve the actual chosen F rather than silently clamp it to pass validation, and require successful worklet ACK/offline Rust evidence before claiming application. This validation does not alter the shared Rust ABI or DAW authorization. The physical pivot P still has a maximum of 20kHz.
## 2026-10-16 unit-icon and fine-gesture consistency audit (#79)

After the #183 compact icon-unit UI release, the visible `.unit-switch button[data-unit]` elements — **not** the visually hidden native `select` — are the actual operator controls. A carrier c locked by Fold-point coupling must disable its number input, slider, native unit-select bridge **and all visible unit-icon buttons**, and restore the same set when unlinked or switched to a mode without a Fold target. Linked c remains read-only; the stored unlinked manual frequency and display unit must not change via a disabled icon. Keep the selected icon visually discernible as unavailable rather than as an active editable button.

The existing #79 precision-modifier contract applies to both **Alt and Ctrl** when operating the pitch-ratio rail. Either temporarily switches the browser's physical `step=0.05` range proxy to `step=any` and bypasses the independent semitone snap target, without rounding the canonical Float64 ratio. If both modifiers are held, releasing only one must keep fine control until both are released. Returning to coarse mode may quantize the gesture proxy but must **not** rewrite the exact typed/gesture canonical ratio.

Each unit icon's `title` and `aria-label` must continue to convey its actual unit (including the ratio icon's alternate semitone/cent tap). Snap ON/OFF and keyboard/context instructions belong to `aria-description` on these icons, not in place of the unit title. Real browser regressions cover all three conditions without touching VST3 ParamIDs, the DSP ABI, or the independent visual editor.

## 2026-10-21 — implementation authority and duplicate prevention (#79, devflow #758)

**Current behavior supersedes earlier historical stages where conflicting:** the unit feature is publicly available in the legacy controls and the V5 virtual-root display, but not every M2/M3 dimension has been migrated. Canonical source and unit semantics live in `parameter-units.mjs` and `parameter-binding.mjs`. The UI adapter is `frequency-unit-field.mjs`; domain-specific rails remain their owning components. See [CAPABILITY_API_CATALOG.md](CAPABILITY_API_CATALOG.md) for per-feature entrypoints, consumers, tests, open migration and explicit differences.

**Binding ownership for V5:** `virtual-root-workbench.mjs` now uses one canonical shared `createParameterBinding` per F/H, with common `parseView` and binding `display/selectUnit`. Its linear integer slider, digit picker and counter are purpose-specific gesture UI, **not a second unit codec**. The dynamic % view uses the same descriptor rail transfer as the canonical binding; no independent frequency or selected-unit store should reappear.

**Guard and limits:** `web-demo/capability-reuse-check.test.mjs` runs in mandatory Web CI. It rejects new numeric-unit editor modules lacking the shared binding/field API, including negative fixtures for superficially imported bindings plus parallel F/H state. The guard only detects the explicitly coded structural signatures; human review must still detect equivalent logic hidden under other names and verify visible UI consistency. No license to fork all other gesture controls, and no claim of full application-wide migration. Open #79 M2 fractional/integer/coordinate adoption and M3 legacy state consolidation remain; native/VST3 automation, Rust DSP and physical iPhone validation are independent.

## 2026-10-21 — common unit-icon renderer (UI reuse completion slice)

The same `createParameterUnitSwitch` exported by `web-demo/frequency-unit-field.mjs` now owns the visible Hz / ♪ / % button elements in both `mountParameterUnitField` and the V5 virtual-root controls. It owns glyphs, accessible titles/labels, selected `aria-pressed` and semitone/cent alternate action. Specialized consumers supply their **binding**, allowed unit choices and `onSelect` adapter; they must not copy icon markup or preserve a second unit-state store. The older hidden `select` remains a compatibility bridge for standard controls only. Virtual-root F/H use their shared `createParameterBinding`; specialized linear rail, digit wheel and number stepper remain separately owned because gesture behavior differs. Existing browser tests cover unit clicks, unit contents, ratio toggling, normal field/snap behavior and mobile virtual-root gestures; static negative fixtures detect new bespoke icon-unit widgets. No Rust/native DSP or DAW host ABI change.


## 2026-10-21 M3 typed fraction field reuse — RELEASED (#79 / PR #289)

**Scope:** the five already-bound scalar fractions `wet`, `a-reverb`, `zero-reflect`, `zero-decay`, and `invert` previously repeated identical numeric input/focus/blur/error controller logic in `web-demo/app.mjs`. The owner is now `web-demo/frequency-unit-field.mjs::mountPercentParameterField({field,binding,refresh,onChanged})`, with a repository catalog entry `fw.parameter.percent-field`.

**Contract:**
- Caller supplies an existing `createParameterBinding` instance (canonical `0..1` Float64 with compatible `percent` unit), its input element, a `refresh(force?)` function, and an optional parameter-specific `onChanged(value,previous)` callback.
- Focus shows three decimal places and selects editable text; `input` and `change` use `binding.setView(raw,{unit:"percent",origin:"typed",overflow:"clamp",notify:false})`, retaining its complete internal Float64 value.
- Invalid or incomplete text never changes canonical state and sets `dataset.invalid`; blur restores the canonical view and clears transient invalid status. Enter blurs/commits. Consecutive input+change for the same canonical value does not emit duplicate callbacks.
- `refresh()` runs after a valid commit; `onChanged` fires **only** when the canonical number changes. WebAudio Wet gain versus Rust revisioned DSP settings remain **consumer-owned** effects; generic input code may not make audio or bridge decisions.
- Returned `dispose()` removes all bound field listeners. The coarse range sliders continue to use existing canonical bindings, not alternate percentage state.
- The module is a local browser ES module API, not a HTTP API or a change to Rust/WASM/VST3 host ABI.

**Evidence gates:** `web-demo/percent-parameter-field.test.mjs` (valid/invalid/precision/focus/change/disposal), `capability-reuse-check.test.mjs` (negative duplicated-controller fixtures), full Web/Chrome/Rust/WASM + offline regression, formal PR review, main readback and Pages only if all required gates pass. This entry is implemented and accepted on exact main `769727696168fe62d62bd14abce0bb8c94111030`, with Browser/Rust/WASM/Chrome #39515770022, Offline #39515769602 and Pages/public-entry #39515769407 all SUCCESS. The remaining M2 coordinate/count and M3 `state.precise` migration stay OPEN; this is not full #79 completion.
