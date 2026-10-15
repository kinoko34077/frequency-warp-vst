# Reloadable Web UI / native VST3 bridge (Issue #145)

This directory begins **UI-1**, an independently testable site-side contract.
It does **not** yet render a WebView in the native VST3: that is the next
bounded native stage. The live `web-demo/` files are deliberately untouched,
so merging UI-1 does not trigger automatic GitHub Pages publication.

## Protocol

`host-bridge.mjs` exports `createHostUiBridge({webview, document, bindings})`.
It runs only when explicitly imported by a trusted local WebView2 page host.
There are no global side effects, no audio processing, and no network calls.
Messages from/to `window.chrome.webview` are structured-clone objects:

- JS -> native: `{ protocol:"frequency-warp.host-ui.v1", kind:"hello", version:1, visibleBindings:[2,3,4,5] }`
- JS -> native: `edit-begin`, `edit-perform` with `value` in [0,1], `edit-end`; each contains permanent VST3 ParamID `id`.
- Native -> JS: `{protocol,kind:"parameter",id,value}`, or `{protocol,kind:"snapshot",values:{"2":0.2}}`.
- Native -> JS: `{protocol,kind:"bindings",bindings:[{id:64,selector:"#gain",min:0,max:100}]}`; JS acknowledges accepted DOM hints.

Native MUST validate message type, frame/source origin, slot ID 0..127,
numeric bounds, command sequence, and the selected engine's accepted slot
semantic identity before calling EditController beginEdit/performEdit/endEdit.
The JS allowlist is UX only and does not grant an engine a new param binding.
If a new module assigns a different semantic ID to slot64, require verified
explicit rebinding and prevent old project automation from silently targeting
it. Module support is intersected with the existing capability mask and
verified engine identity. Unsupported/reserved slot events are ignored safely.

For the existing Frequency Warp site, the four initial DOM controls bind
to stable ParamIDs 2/3/4/5. L/H slider rails map 0..1000 directly to the
existing piecewise-logarithmic normalized host frequency domain. These are
**DOM controls**, not new physical DSP formulas. The unchanged site's input
handlers redraw its graph when the native host sends values; reentrant
automation send-back is explicitly suppressed. Further controls require
verified mapping, not a guess at HTML slider semantics.

## Build / tests

`node --test vst3/ui/host-bridge.test.mjs`

Pure JS tests cover atomic begin/perform/end notifications, duplicate IDs,
selector/path validation, host snapshot UI update without feedback loop,
dynamic mapping to generic slot64, event validity, disposal and cleanup.

Next: pin official Microsoft WebView2 C++ SDK and introduce an opt-in,
native non-RT Win32 `IPlugView` for local HTML/CSS/JS resources. Use the
verified existing `web-demo/index.html` asset graph, retain native file
Browse/Drop/Reload fallback until full parity, and test Windows official
Steinberg Validator. A UI-package path must be local/trusted/versioned;
do not grant JS arbitrary filesystem access or execute WebAudio DSP on the
DAW audio callback. `.fwengine` v1 manifest remains unchanged pending a
separate compatible UI-asset/descriptor package design.

S5 real FL Studio and a second host are still required before release.
