# Frequency Warp: reloadable UI and minimal-rebuild VST3 runtime

Status: confirmed architectural direction, 2026-10-15; implementation incomplete.
Authority: repository Issue #145; implementation roadmap #83; DSP controls #115;
core document docs/VST3_MODULAR_SHELL_SPEC.md. This amendment supplements the
original modular DSP specification; it does not change existing VST3 ClassIDs,
stable ParamIDs, existing physical DSP parameter meanings or engine ABI v1.

## 1. Confirmed requirement

Keep one thin permanent native VST3 host. Permit **independent runtime
replacement** of: (a) the Rust/WASM DSP module (.fwengine), (b) UI HTML,
CSS, JS, SVG and graphics based on the existing Frequency Warp website,
(c) control descriptor metadata (unit/scale/min/max/default/snap/widget),
and (d) semantically compatible parameter-to-engine assignments and
explicit UI links. Routine changes to those layers must not require
recompiling, reinstalling or rescanning the VST3 plugin.

Permitted rebuild exceptions: incompatible native host ABI/capabilities,
actual changes to host-visible param ID count or OS audio interfaces,
new platform binaries, runtime compatibility and security repairs.
The native binary must never self-modify.

## 2. Fixed native and replaceable resource layers

Permanent: Steinberg Processor/EditController class IDs; mono/stereo
audio transport and fixed PDC; 128 DAW ParamIDs; bounded RT mailbox;
out-of-RT Wasmi engine verifier/executor; atomic project archive;
trusted UI asset loader; host automation edit/state/parameter registry;
native package picker and recovery fallback.

Replaceable: UI HTML/CSS/JS resource directory or future validated UI
archive; UI control layout/widgets and notation rules; engine-local
binding descriptors; validated Rust/WASM .fwengine DSP package.

The UI is not the DAW audio engine. Existing Web AudioWorklet, audio file
upload/preview and offline WAV export stay browser functions; the VST3
mode uses the same visual site code but routes controls to native DAW
automation and audio to canonical Rust Stream via native Wasmi worker.
All browser JS and asset I/O are on non-audio threads.

Current experiment: Windows WebView2 SDK 1.0.4258.31, with unchanged
web-demo assets copied to Contents/Resources/ui and served under local
virtual origin https://fwvst.local/. Experimental mode is opt-in using
FW_VST3_WEBVIEW2_PREVIEW=1. The original Win32 engine loader remains
default. Local installed asset files can change without modifying
the VST3 binary; user-facing package reload/rollback is not yet built.

## 3. Stable host slots and semantic binding

Exactly 128 fixed slots: IDs 0..33 are original Frequency Warp parameters,
34..63 reserved native shell slots, and 64..127 generic module slots.
The host records normalized values between 0 and 1. Each engine retains
its own physical canonical unit and transfer function, validated before
connecting the host slot. UI styling or unit changes never change the
stored normalized automation or canonical DSP value implicitly.

For a generic slot the project must persist a verified binding identity:
host slot, engine identity and content revision, engine-scoped semantic
ID, codec revision and actual numeric limits, not merely the slot number.
When loading another engine that does not declare that same semantic
meaning, keep the old automation inert until an explicit compatible
migration is approved. Slot 64 cannot silently change from Gain to
a different effect just because a different .fwengine was loaded.
Older 4/14/18-ID engine packages retain their capability intersection
and must not receive events for unaccepted physical controls.

Descriptor minimum: schema version; immutable engine/semantic IDs;
host slot; display label; dimension; canonical unit; min/max/default;
normalized transfer function; step/granularity; optional snap target
and width; display variant/widget and dependencies. An example manifest,
wire format and schema validation are UI-4 work; this paragraph alone
does not authorize runtime loading or permanently repurpose slot IDs.

Follow docs/PARAMETER_BINDING_SPEC.md for dimensions: Hz, ratios,
fractions, counts, coordinate displacement, note+cents and percent
are allowed only with mathematically valid conversions. A zero-Hz
frequency has no musical note representation. The UI can draw any knob,
slider, number box or switch from descriptors without adding a new
native widget class per control.

## 4. JS/native control protocol

Browser-side adapter: vst3/ui/host-bridge.mjs, imported explicitly by
trusted local WebView. Protocol identifier frequency-warp.host-ui.v1.
UI sends edit-begin, edit-perform (VST3 normalized finite value), edit-end;
native sends parameter and snapshot values to the original DOM.
Suppress echoed DAW edits on incoming UI updates.

The native receiver accepts only the local top-level virtual origin,
strictly bounds and parses commands, and must independently authorize
each ParamID against the active verified binding. Never trust the HTML
label to establish DSP semantics or filesystem permissions. Native
beginEdit/performEdit/endEdit are GUI thread operations; audio callback
still owns the real-time parameter and PCM processing sequence.

Stage UI-3 currently permits only fixed known-audible ParamIDs 2..5:
Lower/Upper Frequency, Invert and Curvature. Browser descriptor support
for slot64 is an isolated JS test, NOT yet an authorized native or Rust
engine binding. Extension to all physical controls must use one generic
validated router rather than one C++ switch per knob.

## 5. UI reload, version pinning and recovery requirements

Future UI loader must resolve only approved local resources. It must
reject path traversal, symlink escape, oversized/unknown assets, bad
versions, and untrusted network/navigation requests. A .fwui single-file
container or separate local directory is a future implementation choice;
the current strict .fwengine v1 ZIP manifest is unchanged.

UI installation/reload must have explicit select/reload/back actions.
A new candidate becomes active only after verified file checks, local
render start and compatible native bridge handshake. On failure keep
the previous verified UI or fallback native picker without stopping
DSP or invalidating DAW state. UI identity/hash/version and binding
semantic identity need persistent project restoration contracts. Browser
or WebView failure is not a reason to trap/crash the audio thread.
No UI asset should acquire a native OS/DSP API that was not already
whitelisted by the fixed bridge.

## 6. Acceptance checkpoints

UI-1: versioned JS host adapter and Node DOM tests — merged PR #146.
UI-2: native opt-in WebView2 renderer, same website assets external to
binary, official Windows SDK/Validator — merged PR #147; real host
visual display still unverified.
UI-3: native WebView2 message receiver and host edit/snapshot for IDs
2..5, C++ parser tests and Validator — merged PR #148; real host
automation record/playback unverified.
UI-4: generic binding descriptor schema/preflight, 64..127 slot identity,
compatibility and saved project semantic bindings — not implemented.
UI-5: production explicit UI reload/rollback, full existing website DAW
mode and offline/failure recovery — not implemented.
S5: FL Studio and second DAW host, audio quality, automation write/read,
project restore, multi-instance, long-run resource/fault tests — unverified.

No installer, external binary distribution or public Pages deployment
is authorized by this source contract or source-only acceptance.
DSP issue #144 remains separate and not completed by Web UI stages.
