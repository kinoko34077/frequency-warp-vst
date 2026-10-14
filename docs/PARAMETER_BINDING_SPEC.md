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
