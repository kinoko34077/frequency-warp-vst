# Frequency Warp — Common numeric parameter and unit contract (proposal #77)

Status: **design candidate**, not a claim that every knob now has a unit menu. Live code initially implements only the shared pure codec in `web-demo/parameter-units.mjs`; the existing main-screen unit labels are unchanged until staged migration.

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

When p∈(0,1), `u` is a nonlinear generalized coordinate. A globally valid constant-Hz label is **not** available. Musical pitch and cents are meaningful for a positive base frequency or dimensionless ratio, not arbitrary percentages. At 0Hz there is no octave/note representation. Music note parses use A4=440Hz by default and can be configured later; output precision does not change the stored Float64 canonical value. For 0.001Hz, numerical pitch formatting is possible but FFT resolution/audio audibility is not implied.

## 3. First implementation / opt-in semantic link

`H=rF/m`; user-facing chain `🔗 H ↔ 起点 P` links these two exact quantities, independent of the existing carrier/Fold-link checkbox.
- **OFF:** mathematical virtual H remains calculated; physical pivot P follows only the existing independent slider/number.
- **ON:** changing F, m or r recalculates H and sets canonical P. Changing the pivot P calculates F=mP/r, clamps F to its declared 20–2000Hz range and publishes the actual realizable H as P. A clamp cannot silently leave inconsistent equal sign.
- `n` and `q` remain their existing distinct virtual arithmetic values; activating H–P does **not** secretly enable Rational Layout, Ring Mod or change the inversion progression.
- The source event is dispatched once. Link-induced updates modify the peer state silently before the existing single render/update callback. No recursive DOM `input` dispatch and no feedback loop. Reset disables the opt-in link; the existing carrier-chain state is not modified.
- Axis pivot's rail now resolves 0 independently, then positive frequencies 0.001..20..20000Hz, permitting a small virtual H without a false forced 20Hz pivot. Existing direct numeric input retains 0.001Hz precision; default P=350Hz.

The marker shown beside `変換形状` is a **Fold L/H hinge** only in Fold modes and a **fixed inversion reference** in Reciprocal, labeled accordingly. The visible marker is intentionally separated from the optional explanatory `ⓘ` popover.

## 4. Possible optional second link: Δ to move u (not implemented)

`Δ = n rF/m = nH`, `R=rF>0`; for p=1, `u=Δ/R=n/m`. For p=0 the value that gives `R+Δ` at reference frequency is `u=ln(1+Δ/R)` **only when** `1+Δ/R>0`; p∈(0,1) requires the common nonlinear inverse coordinate, and signed zero-crossing is not uniformly expressible as the same positive-frequency pitch movement. The slider's existing bounded u∈[-2,2] can also reject desired Δ. **Therefore no automatic Δ→u link or claim of universal equivalence is shipped.** A future opt-in link must explicitly choose reference and behavior on missing/negative/incompatible solutions, and test direction/cancellation against the Rust oracle rather than approximate JavaScript-only audio mapping.

## 5. Migration gates

- M0: shared codec and typed unit matrix with Node tests (this PR). No audible/DSP modifications from view choice.
- M1: adopt a `ParamBinding` object for selected frequency controls (L/H/P/F/carrier/A floor). Unit dropdown next to typed input; Hz↔note+cents↔rail %; preserve exact Float64 canonical state and existing dual-thumb pointers.
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

Acceptance requires Chrome 390px note+cent roundtrip, rail-percent correctness, invalid H input rollback, optional snapped 880Hz, screen-reader thumb text, plus existing L and native/WASM regressions. This is a stacked Draft change, not the public site. Other frequency knobs remain #79 open work.

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
