# VST3 UI-5B2B offline UI switching (source candidate)

Owner: [#251](https://github.com/kinoko34077/frequency-warp-vst/issues/251); canonical design [#145](https://github.com/kinoko34077/frequency-warp-vst/issues/145) and native acceptance [#172](https://github.com/kinoko34077/frequency-warp-vst/issues/172).

## Prepare a candidate

1. Place the complete offline UI under a directory literally named `ui`. The files `index.html` and `host-bridge.mjs` are required; the site must be compatible with the fixed `frequency-warp.host-ui.v1` bridge.
2. Execute `node vst3/tools/create-fwui-manifest.mjs /absolute/path/to/ui` with Node.js. It creates `manifest.fwui` as a sibling of `ui/`, not inside it. An existing manifest is never overwritten.
3. Review the source/publisher of the UI separately. The manifest is **unsigned**: SHA-256 certifies that files match the chosen list, not who authored them. An untrusted publisher should not be approved simply because hashes match.

## Explicit UI switch

The installed default Win32 editor remains the ordinary fallback; the WebView2 editor is opt-in through `FW_VST3_WEBVIEW2_PREVIEW=1` and requires the Microsoft runtime.

Use **Select verified UI** in the permanent **native Win32 toolbar above the WebView**. Webpage content cannot trigger the OS file picker or the Back command. The native Windows file picker selects `manifest.fwui`. The native loader parses the versioned manifest, validates the sibling `ui/` tree and copies each approved byte into an immutable memory snapshot. A separate native confirmation displays the complete manifest path, approved folder path, number and total size of assets, and full manifest SHA-256 (No by default). A webpage cannot directly supply a path or approve a manifest.

On Yes, the shell navigates to its existing local virtual origin, intercepts its WebView2 requests and returns only pinned bytes from the pending snapshot. Nonlocal requests, new windows and browser permission prompts are denied. The shell verifies top-level pinned `index.html` delivery, exact local source, a native Chromium DevTools evaluation that awaits import of the pinned host bridge, checks the result and matches the current native generation and source. A webpage-generated `ui-activation-ready` message is never an accepted commit signal. No pending page can drive DAW edits or bindings.

**Back to previous UI** on the permanent native toolbar repeats the handshake on the preceding verified snapshot after a separate native confirmation. A failed candidate, navigation failure or 8-second handshake timeout leaves the last accepted pinned UI active and reloads it. Audio and existing DAW automation/parameters are not changed by this UI operation.

## Boundaries / physical verification

- The initial bundled website is a legacy installed fallback, not a UI-5B1 externally approved snapshot. Before two pinned candidates have been successfully activated, there may be no pinned Back target; closing and reopening the editor returns to the installed default.
- The approved UI snapshot currently lives with the open editor and is not a persisted DAW project UI selection. A re-opened session therefore needs a new approval. Persistent UI identity restoration remains future work under #172.
- Validation here is source-level/CI (portable tests, VST3 build and Steinberg Validator). FL Studio and a separate DAW must still prove on-screen rendering, automation, save/reopen, multi-instance, timing, audio fallback, UI failure, expired tickets and rollback. CI does not substitute for those physical tests.
- Changing an approved UI cannot change 128 fixed ParamIDs, FWS3 binding meaning, engine ABI, DSP routing or shell binary hash. The native origin and Worker authorization remain separate from displayed metadata.
- No installer, Pages release, update service, network download, browser file-system API or automatic publication is part of this change.

The loader fails closed on resource-response construction errors: a non-success response is installed, or if that is impossible the WebView is stopped and closed rather than allowing a network/directory fallback. This behavior is compile-tested but still requires fault injection in an actual WebView runtime.

### WebView2 interception boundary (reviewed against Microsoft documentation)

Virtual host folder mappings **bypass** WebView2 `WebResourceRequested` callbacks. Consequently, the installed bundled UI alone uses `SetVirtualHostNameToFolderMapping`. Before navigating to a newly approved pinned UI, native code explicitly calls `ClearVirtualHostNameToFolderMapping`; the pinned snapshot is then returned through intercepted responses. On a failed first switch, the installed fallback mapping is restored; on failure after a successful pinned switch, the mapping stays disabled and the last accepted immutable snapshot is served. If the mapping state cannot be changed, native code cancels the swap rather than navigating to an uncontrolled source.

During resource interception, native code acquires a WebView2 deferral before touching response data. Normal results complete only after `put_Response` succeeds. When an ordinary resource response fails, the callback attempts a 503 and schedules rollback. If the 503 itself cannot be delivered, it holds the failing request's deferral and schedules controller termination through the native window message queue rather than re-entrantly calling `Close` in `WebResourceRequested`. This exceptional path must be fault-injected on a real Windows WebView2 runtime before the full physical UI acceptance gate is satisfied.

### Browser state isolation during UI switch

Each opt-in editor requires a WebView2 runtime with `ICoreWebView2Environment10` and `ICoreWebView2Profile2`. It opens a unique **InPrivate profile** and verifies this mode natively, instead of sharing a persistent browser profile across simultaneously open VST3 instances. If these isolation APIs or later hardening registrations are unavailable, optional WebView2 setup closes any partially constructed controller and disables Select/Back. Audio state is unchanged.

For every candidate activation, the shell **first retires the outgoing document to `about:blank` and waits for NavigationCompleted**, then calls asynchronous `ClearBrowsingDataAll` on the private profile and only then loads the new pinned UI. On candidate failure/timeout, it repeats **blank → clear → reload last known good**; a failed storage clear does not grant UI authority and may instead close the optional WebView. Native generation and switch-epoch checks reject stale callbacks. This order prevents the outgoing page from repopulating same-origin storage after a supposedly completed clear. Pinned responses also advertise a CSP blocking workers, frames and object resources. This reduces cross-UI contamination by local storage, cookies, cache and service workers. **It is not a publisher authentication mechanism**: an approved UI's own JS can run with the capabilities of its page until changed. A real WebView2 runtime test must still verify worker removal, session isolation, rollback and concurrent instances.

The renderer preconstructs a 503 deny response during initialization. If a resource deferral cannot be acquired, it tries that response synchronously before scheduling shutdown; it never treats a missing deferral as permission to use the network. If both denial and resource interception fail, it schedules host teardown and tries to stop the view; this extraordinary failure path is not proven without Windows fault injection.

### Native navigation identity and script-dialog recovery boundary

Every native blank/load stage records the **WebView2 NavigationId** reported by `NavigationStarting`; `NavigationCompleted` events whose IDs do not match are ignored. Overlapping, cancelled or page-scripted navigations cannot be mistaken for completion of the native blank/clear/load sequence. During controlled transition, the starting callback requires an exact stage URL and native-initiated navigation, so arbitrary page navigation does not move the transaction forward.

The host turns off WebView2's default JavaScript alert/confirm/prompt/beforeunload dialog boxes, and installs a `ScriptDialogOpening` handler. Only `beforeunload` is accepted (to release an outgoing page for native rollback); ordinary page-generated confirm/prompt dialogs are not granted an affirmative response. Failure to install these controls prevents the optional WebView from remaining active.

These changes are **source and Windows-SDK compile checked**; an actual browser and DAW runtime still must verify event ordering, overlapping cancelled navigations, unload hooks, failure rollback, and default fallback behaviour.
