# Frequency Warp — Browser Audio Preview

## Fastest way to listen (no server required)

Download [standalone.html](./standalone.html) using GitHub's **Download raw file**
control, save it on your computer and double-click it in Chrome/Edge.
It includes all scripts, styles, DSP and Web Worker in one HTML file.
Audio stays local. If file:// workers are restricted by your browser policy,
use the local-server method below instead.

A self-contained **research-only** front end for listening to nonlinear
frequency warping with uploaded local audio. No backend, tracking or audio
upload. Runs with native Web Audio, a module Web Worker and JavaScript.

## How to run

Serve the repository with any local HTTP server (ES module Workers usually
cannot be loaded reliably by double-clicking \`file://\` documents):

\`\`\`sh
python -m http.server 8000
\`\`\`

Open **http://localhost:8000/web-demo/**. On Windows, Python may be named
\`py\`; use \`py -m http.server 8000\` if necessary.

1. Choose or drop an audio file (browser-decoding formats such as WAV/MP3).
2. Select Curvature (0=log, 1=linear), Invert Amount (0=identity,
   1=fully inverted), candidate progression (Fold vs Blend), Quality and Wet.
3. Press "音声を変換する". This performs actual **offline** spectral processing
   in a separate worker; file data stays on the device.
4. A/B playback the original and processed mix or export 16-bit WAV.
5. The Wet slider changes the blend of already-rendered Dry/Wet streams.
   Other parameter changes require explicit re-render.

## Important research boundaries

This is a JavaScript port of the **R2.1 candidate**, not the final
algorithm. It uses STFT peak/instantaneous-frequency estimation, peak
neighborhood analytic-partial inverse FFT and tracked phase-continuous
difference modulation for both channels. It is not 1:1 bit-identical
to Python due to library FFT/numerical implementation differences;
both versions use the same mapping and broad processing scheme.

- Currently limited to **first 10 seconds** and **1–2 channels**.
- Test-analysis band is **20Hz–min(16kHz, sampleRate×0.45)**. Unmatched
  noise and out-of-band components may disappear in this research
  prototype. This is NOT an adopted product band-outside policy;
  the VST3 requirements leave that decision open.
- Quality presets **Eco 1024/256**, **Standard 2048/256**,
  **High 4096/512** define experimental FFT/hop plus peak budgets.
  Their naming does not prove perceptual quality ranking.
- Parameter movement is **not realtime automation**. No WebAudio Worklet
  or DAW integration; the browser worker computes audio before playback.
- Peak collisions, absolute phase, transients, smooth glides, complex
  polyphony, noise/reverb/ambience and any Nyquist/alias protection
  remain unsolved. Do not treat this page as a faithful final sound.
- WAV writer clips to ±1 and saves 16-bit PCM; the normalized levels
  are **not** automatically adjusted to hide gain errors.
- The graph is a **mathematical** mapping [20,20000]Hz independent of
  the dynamic sample-rate-dependent processing band.

## Test

\`\`\`sh
node --test web-demo/dsp.test.mjs
\`\`\`

Tests verify FFT roundtrip, map endpoints/fold/blend, Wet,
actual output sine-frequency movement and linked-channel phase.
The GitHub workflow uses Node to run these; this is **not**
a comprehensive browser device / listening acceptance test.

Owner: [#8](https://github.com/kinoko34077/frequency-warp-vst/issues/8).
Related research: [#5](https://github.com/kinoko34077/frequency-warp-vst/issues/5).
