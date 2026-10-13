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
- Page decodes up to 120 seconds, max input 75 MB, mono/stereo; heavy browser
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
