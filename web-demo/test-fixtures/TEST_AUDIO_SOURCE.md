# Recorded audio fixture

`meta-piano-a0-cc0-3s-48khz.wav` is the first three seconds of the professionally recorded upright piano A0 sample from Meta Open Sound, converted to mono 48 kHz PCM16 for a short, deterministic browser test. It is recorded piano audio, not a generated tone.

- Source: [Meta Open Sound Meta Piano](https://github.com/facebookincubator/Meta-open-sound/tree/main/systems/instruments/meta-piano)
- Source file: `ogg/INSPiano_Vel01_A0_01.ogg`
- Source license: CC0 1.0 Universal; see `META-OPEN-SOUND-CC0-LICENSE.txt`
- Source SHA-256: `83194f023294242361ad1b49287ff971de1fa4f762414b23743170084227d7e0`
- Conversion: `ffmpeg -i INSPiano_Vel01_A0_01.ogg -t 3 -ac 1 -ar 48000 -c:a pcm_s16le meta-piano-a0-cc0-3s-48khz.wav`
- Fixture: 3.000 seconds, mono, 48 kHz, PCM16
- Fixture SHA-256: `69bbdab7ee718e174a23850f5525ff87761ca904a4445e6ae9138ca42b7dd261`

This asset is used only by the Rust-core recorded-PCM regression and is not part of runtime assets or the Pages dependency graph.
