# VST3 UI-5B2B offline UI switching (source candidate)

Owner: [#251](https://github.com/kinoko34077/frequency-warp-vst/issues/251); canonical design [#145](https://github.com/kinoko34077/frequency-warp-vst/issues/145) and native acceptance [#172](https://github.com/kinoko34077/frequency-warp-vst/issues/172).

## Prepare a candidate

1. Place the complete offline UI under a directory literally named `ui`. The files `index.html` and `host-bridge.mjs` are required; the site must be compatible with the fixed `frequency-warp.host-ui.v1` bridge.
2. Execute `node vst3/tools/create-fwui-manifest.mjs /absolute/path/to/ui` with Node.js. It creates `manifest.fwui` as a sibling of `ui/`, not inside it. An existing manifest is never overwritten.
3. Review the source/publisher of the UI separately. The manifest is **unsigned**: SHA-256 certifies that files match the chosen list, not who authored them. An untrusted publisher should not be approved simply because hashes match.

## Explicit UI switch

The installed default Win32 editor remains the ordinary fallback; the WebView2 editor is opt-in through `FW_VST3_WEBVIEW2_PREVIEW=1` and requires the Microsoft runtime.

Use **Select verified UI** in the permanent **native Win32 toolbar above the WebView**. Webpage content cannot trigger the OS file picker or the Back command. The native Windows file picker selects `manifest.fwui`. The native loader parses the versioned manifest, validates the sibling `ui/` tree and copies each approved byte into an immutable memory snapshot. A separate native confirmation displays the complete manifest path, approved folder path, number and total size of assets, and full manifest SHA-256 (No by default). A webpage cannot directly supply a path or approve a manifest.

On Yes, the shell navigates to its existing local virtual origin, intercepts its WebView2 requests and returns only pinned bytes from the pending snapshot. Nonlocal requests, new windows and browser permission prompts are denied. The shell verifies top-level pinned `index.html` delivery, exact local source, a Chromium native async DevTools evaluation that awaits import of the pinned host bridge, checks its returned boolean, and matches the active native generation and source. A webpage-generated `ui-activation-ready` message is not accepted **before** accepting the new UI. No pending page can drive DAW edits or bindings.

**Back to previous UI** on the permanent native toolbar repeats the handshake on the preceding verified snapshot after a separate native confirmation. A failed candidate, navigation failure or 8-second handshake timeout leaves the last accepted pinned UI active and reloads it. Audio and existing DAW automation/parameters are not changed by this UI operation.

## Boundaries / physical verification

- The initial bundled website is a legacy installed fallback, not a UI-5B1 externally approved snapshot. Before two pinned candidates have been successfully activated, there may be no pinned Back target; closing and reopening the editor returns to the installed default.
- The approved UI snapshot currently lives with the open editor and is not a persisted DAW project UI selection. A re-opened session therefore needs a new approval. Persistent UI identity restoration remains future work under #172.
- Validation here is source-level/CI (portable tests, VST3 build and Steinberg Validator). FL Studio and a separate DAW must still prove on-screen rendering, automation, save/reopen, multi-instance, timing, audio fallback, UI failure, expired tickets and rollback. CI does not substitute for those physical tests.
- Changing an approved UI cannot change 128 fixed ParamIDs, FWS3 binding meaning, engine ABI, DSP routing or shell binary hash. The native origin and Worker authorization remain separate from displayed metadata.
- No installer, Pages release, update service, network download, browser file-system API or automatic publication is part of this change.

The loader fails closed on resource-response construction errors: a non-success response is installed, or if that is impossible the WebView is stopped and closed rather than allowing a network/directory fallback. This behavior is compile-tested but still requires fault injection in an actual WebView runtime.
