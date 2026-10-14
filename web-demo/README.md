# Web Audio Preview — real-time playback via shared Rust DSP

GitHub Pages: https://kinoko34077.github.io/frequency-warp-vst/

## Real-time behavior (Issue #14)

**Play original** or **Play real-time warp** starts audio without first
processing the whole 10–120 second recording. The source is decoded once
in the browser, streamed through **AudioWorklet 128-sample quanta**, with
actual spectral transformation in \`core/src/stream.rs\` compiled to WASM.
The exact same Rust source is also compiled for the native library
(and its persistent \`warp_stream_*\` C ABI can later feed VST3).

L/H, Curvature, Invert, Fold L/H/Blend and outside Pass/Kill update the
persistent DSP on the audio rendering thread. They do **not** schedule a
new whole-file render. Wet is mixed as a WebAudio gain change instantly.
Quality changes replace/reset the stream because FFT size and lookahead
change.

Click or touch **any point on the waveform** to start/restart from that
sample position. Keyboard: Enter/Space starts playback at current seek
marker; arrows step by two seconds. Playback loops for experimentation.
A vertical marker shows current play position and the elapsed time.

**WAV export** is an explicitly separate, collapsible offline facility.
Only file export requires rendering the complete file. Preview/playback
never waits for this render. Audio stays entirely on the device.

## Important DSP limitations

- This is a **research-grade R2.1 peak/sinusoid streaming candidate**,
  not the full mature offline re-synthesizer, and not a completed VST3.
  It uses the same Rust frequency map and peak/phase principles but a
  computationally cheaper overlapping oscillator resynthesis in the
  streaming path. It may distort, drop transients/noise, or produce
  artifacts; acoustic equivalence with offline output is not claimed.
- Rust streaming uses a finite Hann STFT window. Current test presets:
  Eco FFT1024/hop256, Standard FFT2048/hop256, High FFT4096/hop512.
  DSP reported lookahead is N−1 samples; for Eco at 48kHz, about 21.3ms,
  plus device/browser output latency. It is **not zero latency**.
- Quality/CPU capacity depends on platform and audio device. AudioWorklet
  has a hard scheduling deadline. The runtime exposes approximate DSP
  processing time for sampled render quanta; success in CI does not
  guarantee glitch-free performance on all mobile devices.
- Input outside [L,H] Pass/Kill operates via spectral reconstruction of
  complementary FFT bins. Negative destination frequency Reflect/Kill/Fade
  remains a separate unimplemented requirement.
- Page decodes up to 600 seconds, max input 75 MB, mono/stereo; heavy browser
  memory usage is possible. Do not imply full-length rendering is instantaneous.

## Build / verification

\`\`\`sh
cargo test --manifest-path core/Cargo.toml
rustup target add wasm32-unknown-unknown
cargo build --manifest-path core/Cargo.toml --release --target wasm32-unknown-unknown
cp core/target/wasm32-unknown-unknown/release/frequency_warp_core.wasm web-demo/dsp_core.wasm
node --test web-demo/core-wasm.test.mjs
python3 -m http.server 8000
\`\`\`

Open http://localhost:8000/web-demo/ . GitHub CI additionally runs
headless Chrome, loads 12-second WAV audio, starts AudioWorklet streaming,
changes a live parameter, and clicks a waveform seek position without
instantiating the legacy whole-file Worker. Original/reference Python
tests remain separate evidence.

Technical owner: [Issue #14](https://github.com/kinoko34077/frequency-warp-vst/issues/14).


## Fixed square 20–2000 Hz graph / #16 formula analysis (Issue #17)

The graph is **always 20–2000Hz on both axes**, on a square canvas, even
when L/H are much higher. Only the transformed [L,H] region is highlighted;
Pass outside that interval follows the diagonal, and Kill removes its trace.
Anything above 2kHz is *clipped from the visualization only* and continues to
be processed normally. A Ring Mod setting plots both sum and difference
sidebands, not a single invert mapping.

A read-only *theoretical* table models Issue #16's integer harmonic series:
- Original ideal fundamental F (entered manually, **not detected**);
- rational index m/n, virtual-grid fundamental H=F/m;
- signed constant shift Δ=nF/m;
- translated harmonic kF+Δ=(mk+n)H;
- negative-frequency fold |kF−S| and the selected harmonic's landing
  at H for S=(q+1/m)F;
- Ring Mod sum/difference f+c and |f−c|;
- pitch-first order r f+Δ, which is not identical to r(f+Δ).

These are algebraic facts about ideal synthetic tones; audible pitch,
absolute phase, and coincident amplitudes in real recordings are empirical
questions. [Historical minutes #16](https://github.com/kinoko34077/frequency-warp-vst/issues/16)
remains a research record, not proof of production DSP quality.

## Algorithm selector (actually implemented in shared Rust/WASM)

| Engine | DSP | Practical interpretation |
| --- | --- | --- |
| A | STFT prominent partial tracking + oscillator resynthesis | Stable-ish tonal peaks; noise/residual removed |
| B | STFT spectral bin reassignment / inverse FFT | Grid-quantized, phase rough; experimental lower-peak overhead |
| C | Ring Mod x(t)·cos(2πct) | True low-cost time-domain two-sideband effect, **not frequency inversion** |
| D | Partial tracking + manual pitch ratio r then signed Δ=nF/m shift | Ideal harmonic lattice controls, negative targets experimental |

Other proposals in Issue #3/#5 (analytic direct inversion, partial+noise
residual, chirplet/nonuniform spectral analysis) are shown as
**disabled research candidates**, because no tested engine exists yet.
Selecting them would be misleading. These are not alternative names for A/B.

FFT window length 1024/2048/4096 and hop N/4 or N/8 are selectable. A change
of FFT shape restarts the streaming state and alters algorithmic lookahead
(N−1 samples). AudioWorklet itself always processes **128-sample quanta**;
that is a browser runtime constraint, not a configurable block size.
For Ring Mod, FFT window controls have no audio effect: the Ring engine
bypasses the FFT and has 0 FFT lookahead.

The site reports approximate DSP callback time and the count of callback
deadlines exceeded on the testing machine, without guaranteeing mobile
real-time performance. All engine paths use Rust WASM; the Web UI draws
formula and graph previews only and does not implement a separate DSP.


## 2026-10-13 user-first workstation (#19)

The Web page is reorganized around auditioning results rather than around
DSP implementation parts:

- Desktop: two-column workstation. Left: import, clickable waveform,
  transport, Invert, Curvature, Wet and L/H. Right: square 20–2000 Hz
  graph with an adjacent Harmonic Lab tab. Mobile: reflows to single
  column without horizontal overflow.
- Gear button opens a modal with audio-engine selection, Fold mode, L/H
  outside policy, FFT/hop, and negative-frequency handling. A live change
  goes to the Rust AudioWorklet; changing FFT shape/engine rebuilds the
  stream at the approximate current playhead. Closing settings doesn't
  reset transport.
- Harmonic F, m, n, q, r and Ring carrier have **both draggable ranges
  and exact numeric fields**, synchronized in real time. A checkbox
  links carrier c to the current *input-domain Fold kink* and displays
  the resolved Hz from the Rust WASM mapping. Checked + Blend uses manual
  Hz with a clear message because Blend has no Fold kink.
- Browser graph calls shared Rust WASM warp_map_frequency rather than
  running separate JavaScript curve arithmetic. The independent JS
  reference is test-only. WAV export routes through the **same Rust
  streaming DSP** as realtime audition, offset by its algorithmic
  lookahead; it no longer exports a different offline algorithm.
- Reset affects effect parameters but not the loaded file or seek position.

UI quality was assessed against the entire user-supplied
「利用者起点 UI/UX 設計原則」 and is documented in
docs/SHARED_DSP_ARCHITECTURE.md / Issue #19. Automated native,
WebAssembly and Chrome tests demonstrate controls and responsive layout;
actual iPhone gesture/audio quality and human usability remain
UNVERIFIED pending physical testing.


## 2026-10-13 expanded audition and controls (Issue #22)
- Browser playback can preview up to **600 seconds**, including click/touch waveform seeking; source file cap remains 75MB. Decoding/memory cost grows with duration; this is NOT independently certified for every iPhone generation.
- Mobile: compact square 20Hz–2kHz frequency plot with an equal-scale *inner plot*, and 3-harmonic miniature panel always visible alongside the graph. Expanded formulas no longer hide the plot; Settings selects detailed count 3/5/7/12/16/24/32.
- Rust engine 2 now **warps first**, then time-domain Ring Mod generates two sidebands. Engine 3 now applies Warp -> pitch-ratio -> signed-Hz shift to tracked in-band partials. Therefore Invert/Curvature influence both effects. Unlike the old samplewise Ring-only mode, current Ring pipeline inherits FFT latency and higher CPU cost.
- A shared Rust post-effect Bit Crusher quantizes sample amplitudes (2–16 bits) and reduces sample update rate by sample hold (1–32 samples), independently toggled and adjustable during playback. WAV export uses the same settings and Rust Stream.
- Browser full-file WAV export still has a **40,000,000-sample safety cap**; long stereo clips may be auditioned but cannot necessarily be exported without memory risk. The UI explains this instead of failing silently.
- **Five DSP algorithm families are not all implemented:** analytic complex-modulated direct linear inversion and whole-file Fourier reposition remain offline research references; STFT tracked peaks and sinusoidal resynthesis exist experimentally; residual reconstruction and high-resolution chirplet/nonuniform analyses remain unimplemented. See docs/SHARED_DSP_ARCHITECTURE.md and #17/#5 for exact authority.


## Unified frequency-axis shift and reference tone (Issue #25)

- **DSP synthesis method** in Settings contains the actual experimental
  reconstruction implementations (partial oscillator, FFT-bin frame
  relocation). Ring Mod, Bit Crusher, signed axis shift, and optional #24
  rational partial-grid model are **effects/transform settings**, not
  competing sound reconstruction technologies.
- The main "周波数軸の上下移動" slider spans u=−2…+2. The existing
  Curvature p controls whether that signed displacement occurs in
  logarithmic frequency coordinates (p=0, multiply every target frequency
  by exp(u)) or linear coordinates (p=1, add u*F' Hz), with continuously
  interpolating p values. F' = manual F × user pitch ratio. At p=0 this
  is the usual single-ratio Pitch Shift in the *ideal frequency mapping
  model*; at p=1 it is the usual constant-Hz Frequency Shift. Acoustic
  quality still depends on the chosen experimental resynthesis algorithm.
- The virtual H=r_pitch*F/m is shown along with its translated marker
  H_moved=T_p(H). For constant-Hz shifts, H_moved is a position marker,
  NOT a guaranteed acoustic/mathematical fundamental of the output.
  Nonlinear spectral Warp likewise generally invalidates fixed
  integer-harmonic source assumptions.
- The optional WebAudio **reference sine** plays at gentle volume even
  without an uploaded source; its slider displays an equal-temperament
  note name, octave, signed cents and Hz. Sine output is local to Web
  audition and does not modify exported audio. Turn it off to stop it.
- All actual audio frequency-coordinate transforms and negative
  frequency rules execute in shared native/WASM Rust; graph uses the
  exported Rust operator for its frequency movement.

## 操作の整理（2026-10-14）
傾きはHz間隔の倍率。起点0Hz・傾き2×・移動0で全成分が2倍（曲率0～1のどちらでも成立）。曲率は別の移動操作の対数／線形を選ぶもの。数値は各スライダーの右側をタップして直接編集。グラフをタップすると2kHz／20kHzを切り替え、細線の透明度にMixが反映されます。通常表示は短い変換例と再生状態に限定し、数式と処理情報は展開可能。Media Session対応によるバックグラウンド操作を追加（iPhoneロック画面での連続処理は実機未検証）。

## 2026-10-14 exact direct-entry precision and cold-start decode (#37)

All continuous numeric readouts (including main controls, threshold numbers,
harmonic F/r/carrier, and reference-tone Hz/cents) allow **three decimal
places when entered directly**. The underlying Rust/WASM audio parameter
uses that stored value, even if the visually accompanying drag slider has
a coarser step. On leaving a number field, the UI displays the value
rounded to at most **two** decimal places; refocusing reveals the retained
precise value. Moving the slider replaces that precise value with the
slider's selected increment. Integer-valued parameters remain integers.

The first iOS file-picker return can encounter a stalled WebAudio decoder.
The offline decode attempt now has a 6.5-second watchdog and automatically
tries a second, independently created **suspended** AudioContext decoder
without awaiting AudioContext.resume(). File-byte reading and alternate
decoder also have deadlines. Status text announces the fallback and
reports failure instead of leaving an indefinite loading message. An
automated Chrome test deliberately hangs the first decoder on a fresh
page and checks that a single file selection recovers. This is Chrome
evidence; hardware iOS codec/OS-specific behavior still needs an iPhone
check to be considered independently verified.


## 2026-10-14 settings and engine-A peak selection (Issue #41 / PR #42)
- A/B options omit a subjective “standard” tag. The optional **反転で切り替え** checkbox follows the *final audible main mapped curve* over the in-band range: shared Rust/WASM nonlinear warp plus physical pivot/translation, rational stage, and signed zero policy; A when the surviving curve overall descends, B otherwise. Ring sidebands and logarithmic display scaling do not change this choice. The UI shows the effective automatic engine rather than a stale disabled manual dropdown; disabling restores the previous manual selection. This is not an audio-quality ranking.
- Engine A adds 1–8 FFT-bin **peak neighborhood / isolation** control (default 1 preserves the former candidate selector). A larger value excludes neighboring weak peaks and may reduce high-frequency flutter, but may also remove close partials; it does **not** reconstruct residual/noise and must not be reported as R2.2 research acceptance. Both AudioWorklet and WAV export call the same Rust setter/engine, retaining the old streaming/offline ABI entries.
- The graph has a display-only 0–100% linear/log frequency-axis slider, applied identically to both square x/y axes; it does not change sound or the engine policy. 20 kHz view now shows low-frequency details through logarithmic spacing.
- Defaults: `mode=blend`, detailed harmonic rows 5, displayed numeric precision up to 3 decimals. 2/3 display digits are selectable without truncating the stored 0.001-precision typed DSP values. Integer controls remain integers.
- The settings dialog scrolls within a flex-sized body on mobile and desktop, with a compact per-control explanation. Native selector `change` events update the shared Rust DSP without touching any other slider.
- The PR #42 implementation passed native Rust, WASM, headless Chrome and Python reference CI, with a formal exact-head review. See Issue #41 for the release/deployment evidence and acceptance status. Physical iPhone behavior and subjective engine-A quality remain unverified.


## 2026-10-14 public-entry deployment repair (Issue #43 / PR #45)

The previous GitHub Pages deployment manually copied a fixed list of
`web-demo/*.mjs` files. It omitted `engine-policy.mjs` and then
`export-policy.mjs`, each required by top-level `app.mjs` imports. The
live page therefore could fail to initialize **all** JavaScript event
handlers despite locally successful Rust/Chrome tests and a green Pages
deployment job. This affected both opening Settings and activating the
audio file picker.

Publication now stages the transitive literal same-origin static resource
graph from the HTML entry using `web-demo/stage-pages.mjs`. Missing
dependencies fail the build. The regular CI tests against this **same
staged artifact**, with mobile Settings, actual browser FileChooser and
sample WAV decoding in `entry-smoke.test.mjs`. The Pages workflow
additionally runs the browser entry test against the **public deployed
URL after deployment**. A mere green build/deploy is not sufficient to
claim the UI works.

The visible audio-file drop area is itself a native file-input target;
no programmatic proxy click is required on iOS. Settings open/close lives
in a small independent `entry-controls.js` script, and remains available
even when the DSP module graph cannot initialize. An explicit error is
displayed if the main application never boots. Chrome touch simulation
and live HTTP/browser checks do not constitute a physical iPhone test.

## 2026-10-14 audio replacement recoverability and WAV audit (#46)

- **Audio timeline audit — NOT A BUG.** The native Rust `Stream::latency()`
  is `fftSize - 1` (1023/2047/4095 frames), and the realtime AudioWorklet
  delays its Dry output by that many frames. However, importantly, Rust's
  `warp_stream_render_f32_a_band_ext` **compensates that latency before WAV
  export** by discarding the leading delayed samples and flushing the
  remaining tail with zero input. Thus the existing offline samplewise
  `mixWet(source, processed, wet)` is correct and **must not delay Dry again**.
  A temporary mistaken alignment change on the unmerged audit branch was
  reverted after checking the complete native Rust offline render.
  Automated Chrome verifies the real downloadable WAV at 0%, 50%, 100% Wet
  against samplewise PCM midpoint, without falsely assuming a leading
  silence section.
- **Confirmed recoverability bug corrected.** Previously any failed file
  replacement (invalid / too short / too large) discarded the currently
  loaded track, rendered WAV and transport, even though the replacement
  was never usable. Now the new file is decoded and validated independently
  first. Failure leaves the previous audio and its output accessible with
  explicit error feedback; success atomically commits the new file and
  resets the previous seek and render. Concurrent import tokens prevent
  stale decode operations overriding a newer selection.
- Test acceptance uses a 390px mobile Chrome/public Pages sequence
  valid WAV → too-short WAV → valid WAV, plus real offline WAV 0/50/100
  byte-level tests and the existing Rust/WASM live streaming tests. Physical
  iPhone hardware and subjective sound differences remain UNVERIFIED.

## 2026-10-14 A fidelity / CPU budget knob — staged Issue #50
Settings has an independent Engine A "再合成精細度" slider 0–100.
It changes the **actual common Rust/WASM** maximum selected peaks per STFT frame
and peak acceptance magnitude floor, both live and in WAV export. Quality=0
preserves the prior N=1024/2048/4096 limit 6/10/18 and threshold
9/4.5/2.5% of strongest frame component. Quality=100 allows 24/40/72
partial tracks and threshold 0.9/0.45/0.25% respectively. The retained
"抽出帯域幅" 1–8 slider still controls local FFT-bin peak isolation
*independently*. Processing-state vector capacities are reserved when
the audio stream is created; slider changes do not allocate new buffers
on the real-time processing thread.

The UI shows actual budget and threshold and the already existing
AudioWorklet averaged block render cost and overbudget count.
**A larger peak budget is more detailed tracking, NOT guaranteed higher
fidelity, formant preservation or residual/noise recovery.** High settings
can seriously overload slower phones. A's no-op quality defect #48
and residual-only scientific work #5 remain independent unresolved goals.
Do not confuse this control with a perceptually accepted fidelity metric.

## 2026-10-14 Engine B interframe-phase coherence — staged Issue #50
The existing FFT-bin relocation previously moved local-frame complex
coefficients without the extra global-time phase rotation needed when
the carrier moved to another integer FFT bin. Consecutive overlapped
frames therefore could *cancel* for nonzero frequency offsets, even
when the move was exactly representable on the FFT bin grid.
The shared Rust B branch now rotates each relocated complex coefficient
by `2π(dest−source)·(start modulo FFT_N)/FFT_N` before IFFT and weighted
overlap-add. This has identical behavior for identity (`dest=source`)
and zero-reassignment cases. Tests compare real shared Rust/WASM PCM
against exact ±3-bin/0-bin shifted sine waves under both 4× and 8×
overlap and fail on the old phase-cancelling implementation.

This is specifically a frame-to-frame phase-continuity correction for
integer-bin movement. It **does not** preserve formants, resolve
non-integer-bin quantization or folded many-to-one spectral collisions,
or implement a full phase-locked vocoder, WSOLA or élastique.
Those candidate quality improvements remain scientific work under
Issue #50 and research owner #5; subjective iOS confirmation remains
UNVERIFIED. The separate A detail/CPU slider is unaffected.

## 2026-10-14 A quality slider mapped-residual experiment (#50, Stage 3)
With nonzero A quality, the same Rust streaming engine now reconstructs
part of the previously discarded **in-band residual spectrum** (not an
unwarped copy of Dry): it excludes the selected peak and its immediate
Hann mainlobe neighbours, applies the exact same warp / rational placement
/ axis translation / 0-Hz policy as the tracked partial, applies absolute
frame-start phase rotation to relocated residual FFT bins, then uses
the same overlap-add output accumulation. Quality=0 remains the original
peak-only mode; increasing quality increases peak tracking budget, lowers
selection threshold AND increases residual reconstruction amount from
0 to 100%. The FFT scratch and Boolean peak mask are allocated when
the stream is constructed (no per-frame allocation). The overlap-add
reference and latency compensation are unchanged for exported WAV.

A deterministic direct Rust/WASM test at 12kHz, FFT1024, no warp/FX
reported **normalized RMSE** baseline vs maximum quality: wideband
noise 0.88242 → 0.11839, 440Hz+noise 0.34967 → 0.11139,
gated 880Hz burst 0.87981 → 0.22621. Offline elapsed time
varied with input/quality, not an iPhone real-time speed certification.
A linked stereo + nonzero 480→504Hz test independently rejects
unshifted ghost and distorted channel balance.

This mask is approximate. In the *full non-linear* fold, where several
source frequencies can map to one target frequency, spectral collision,
variable formants, onset smearing and phase-locking remain unresolved.
It is not a claim that #5's independent R2.2 research candidate, native
VST3 or perceptual tuning are complete.

## 2026-10-14 Ring source-band and crusher-frequency controls — Issue #54 stage U1

The Ring Mod checkbox applies carrier amplitude modulation to the **processed
source-frequency range [L,H] only**. Out-of-band `Pass` material is
independently inverse-STFT reconstructed and added **after** Ring Mod; out-of-band
`Kill` still removes it. The actual source bandwidth uses the same [L,H]
as the green frequency-map graph; it does not restrict generated upper/lower
sidebands to [L,H]. Linked carrier still derives from the input-domain Fold
breakpoint; otherwise manual carrier in Hz. This is shared native/WASM Rust
DSP for realtime and WAV, and sample-phase is based on absolute analysis time
so overlapping windows agree.

The bitcrusher interval uses a **requested Hz** control (slider low→high
from left to right, instead of the old 1→32 held-sample direction). Actual
zero-order hold is integer `hold=round(Fs/requestedHz)` limited to 1..32;
the effective frequency displayed is `Fs/hold` and can differ from the
requested Hz. This is sampling/holding, **not** frequency filtering. The
main mapping graph adds candidate alias folded-frequency trajectories when
the crusher is ON and the reduced sample rate can cause aliasing. Their
amplitude is **not estimated**. A separate small synthetic 4.3-cycle waveform
shows original sine in gray and sample-held amplitude-quantized signal in
orange; it is an explanatory model, never the waveform of the loaded file.

## 2026-10-14 Inversion coordinate equations and geometric reciprocal interpolation — Issue #54 U2
The frequency graph axis slider changes DISPLAY coordinates only. Position
on each axis is `Gα(f)=(1−α)(f−20)/(M−20)+α·ln(f/20)/ln(M/20)` with
`α=slider/100`, `M=2000` or `20000`. It does not change audio.
The separate Warp movement-scale slider chooses mathematical frequency
coordinate `S₀(f;L)=ln(f/L)` at `p=0`,
`Sₚ(f;L)=((f/L)^p−1)/p` at `p>0`, and the movement endpoints
`f×exp(u)` (p0) vs `f+uR` (p1), subject to independently selected
anchor/pivot/slope and nonlinear inversion.

A new invert progression `reciprocal` interpolates geometrically between
the original `f` and full existing inverse `Iₚ(f)`:
`f'=exp((1-a)ln(f)+a ln(Iₚ(f)))`, `a=invert`, valid positive [L,H].
It equals identity at a=0 and the same full inversion at a=1.
For p0, I=LH/f and fixed reference is sqrt(LH). At a=.5 p0 all
positive input frequencies meet at the fixed reference (an inherent
many-to-one mapping, NOT transparent audio).
The invert slider shows input-side Fold breakpoint in Hz for FoldL/H,
reciprocal inverse fixed point in Hz for this mode and percent-only
for linear Blend, which has no unique breakpoint.
Rust is the sole production mapping implementation via WASM. The separate
JavaScript oracle is TEST ONLY; no duplicated audio/DSP.

## Issue #54 U3 — 0Hz反射率

主画面に「0Hz以下の折返し・減衰」シークバー（0〜100%）を追加。
負周波数へ移動した部分音だけを正の周波数 |f'| に反射し、
振幅を設定率 g/100 倍にする。0%は除去、100%は全量折返し、
中間は減衰。正の周波数へ移動した成分は変化しない。
周波数グラフは反射成分を同じ透明度で表示する。
Rustの AudioWorklet と WAV 書出しで同じ演算を行う。
既存の0/1/2モードのABIは保持する。

## Issue #59 S1 — 0Hz reflected signal has TWO independent controls

This corrects the single-slider interpretation in #54 (already released).
The main panel stacks:
- **合成率** C: 0..100% uniform reflected negative-target synthesis amplitude.
- **減衰率** D: 0..100% frequency-distance falloff from the 0Hz folding boundary.

At signed mapped frequency f'<0, the shared Rust DSP reflects frequency to
|f'| and multiplies amplitude by
`C*(1-D)^(|f'|/R)`, where C,D are in [0,1] and R is the currently
configured positive axisReference frequency in Hz. D=0 means no distance
attenuation; D=.5 halves amplitude every R Hz (−6.0206 dB/R); D=1
kills all strictly negative components. Nonnegative mapped frequencies
and outside L/H Pass are unchanged. The graph queries the SAME compiled
Rust/WASM gain oracle for each sample rather than using a separate visual
law; opacity reflects the effective amplitude, not a measured audio FFT.
Both controls reach realtime AudioWorklet and WAV offline. Legacy native
zero-reflection ABI callers retain their old behaviour (falloff=0).

## Issue #59 S2 — True 0Hz crusher hold and physical spectral images

The requested bitcrusher update frequency now spans 0Hz to the actual
source sampling rate. Zero requests a frozen first processed sample, with
no subsequent updates. A positive target R is implemented by the shared
Rust integer hold N=round(Fs/R) up to 1e9 samples. The UI distinguishes
requested R from the actual effective Fs/N. The offline WAV export uses
the original file's Fs while AudioWorklet uses its current AudioContext
sample rate; both run the SAME Rust streaming DSP.

The main frequency graph now has a true 0Hz origin and a logarithmic
display interpolation G_alpha(f)=(1-alpha)f/M +
alpha*ln(1+f/20)/ln(1+M/20). It draws the actual effective update
Nyquist mirror y=Fs/(2N) and additional half-integer reflected
boundaries, never fake dotted alias lines. Solid colored lines represent
selected sinusoidal spectral images after discrete N-sample zero-order
hold. For a COMPLEX sine they occur at f+k*Fs/N (folded into hardware
0..Fs/2) and their exact linear-stage magnitudes are
abs(sin(pi*N*frequency/Fs)/(N*sin(pi*frequency/Fs))) at the signed
image frequency. The baseband image and representative neighbouring
images are drawn with the correct amplitude-dependent transparency.
Ring Mod sidebands are each half the sinusoidal input amplitude;
0Hz freeze produces DC rather than audible oscillations.

Finite-bit quantization is nonlinear: extra harmonics depend on the
amplitude and phase of the actual input. Therefore these lines are
STRICTLY the analytical linear sample-hold response of a single
sinusoid; they cannot be an exact complete FFT of an arbitrary uploaded
song, nor can the extra quantization harmonics be deduced from input
frequency alone. The original dashed diagonal is a reference only.
The separate synthetic waveform example is retained, now with faint
sample-update clock/history lines and horizontal quantizer-step levels,
coarser and more visible at low update rates or bit depths.
