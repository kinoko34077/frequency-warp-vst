# Cross-site Visual Editor — v0.5.1 current source and historical M1–M5 pilot

## Current accepted state (2026-10-16)

**M1–M5 source and three-site GitHub Pages release: DONE.** This directory is the canonical source for the **private** offline ESM package `@kinotch/visual-editor-platform@0.5.1`, accepted at Frequency Warp commit `a34c23292cb585c35637e53574dc5fbd7251e507` ([#187](https://github.com/kinoko34077/frequency-warp-vst/issues/187), PRs #188/#189). Source and its `package.json` are committed; there is **no npm registry publication**, browser-side GitHub write, CDN auto-fetch or implicit external synchronization.

- **Frequency Warp:** editor source included in the published Pages site ([Pages #38794251276](https://github.com/kinoko34077/frequency-warp-vst/actions/runs/38794251276) SUCCESS). The whole-repository `main` has moved beyond the accepted editor source commit due to separately owned Web/native VST3 work; this does not change the source provenance.
- **LINE:** independent static-DOM integration, [#56](https://github.com/kinoko34077/line-style-viewer/issues/56) DONE, [Pages #38720026277](https://github.com/kinoko34077/line-style-viewer/actions/runs/38720026277) SUCCESS.
- **Gomoku-5D:** opt-in isolated React layout-card model pilot, [#17](https://github.com/kinoko34077/Gomoku-5D/issues/17) DONE, [Pages #38721947113](https://github.com/kinoko34077/Gomoku-5D/actions/runs/38721947113) SUCCESS. The earlier Pages enablement problem and favicon 404 are resolved, not current blockers.

Both consumer repositories pin the same `a34c232...` source commit and validate the same eight shared package Git blob SHAs offline. In particular, `export.mjs` is `6cef513a5fee723c753c933ea8478018d54dfcd2` across all three repositories. App-specific route mappings and ownership declarations are configuration, not divergent shared engine copies.

**Capability boundaries:** the shipped editor is explicit opt-in, local-first and capability-gated. Static DOM safe styling and source-reviewed CSS/HTML proposals, React/scene model structural operations and layout-only JSON outputs have different owners and export permissions. Arbitrary production React/Canvas editing, JSX reverse-mapping, physical iPhone Safari behavior, extended memory/saturation testing, and native VST3/DSP parameters have **not** been accepted by this M5 release. Bounded three-site Chrome metrics and M5 history: [devflow #560](https://github.com/kinoko34077/devflow/issues/560).

---

## Historical M1–M4 pilot chronology (not the current release state)

**At the pilot checkpoint only:** branch `feat/web-generic-visual-editor-m1-m4-20261015`, local owner [#161](https://github.com/kinoko34077/frequency-warp-vst/issues/161), cross-repo [devflow #560](https://github.com/kinoko34077/devflow/issues/560), initial design [#154](https://github.com/kinoko34077/frequency-warp-vst/issues/154). The original work was Draft/unreleased and M5 was then incomplete; those gates were later superseded by reviewed merges and public Pages verification. Technical examples below are retained for provenance.

## M0 decisions adopted for this pilot

Application/renderer/domain owners remain authoritative. Persist **semantic node IDs** defined by app code (`data-ve-id`); never persist ephemeral CSS paths or DOM indices. All editing is opt-in, local-only. Without a renderer-validated capability, an operation is denied.

The editor owns its own design document and history, not application settings, chat history, DSP parameters, audio state or VST3/DAW bindings.

## Included implementations

| Phase | Pilot source | Evidence |
| --- | --- | --- |
| M1 | `core.mjs`, `dom-adapter.mjs`, `ui.mjs` | Typed operation validation, stable node resolution, strict CSS whitelist, opt-in Frequency Warp UI at `?visual_editor_v2=1`, previous `?layout_editor=1` unaffected |
| M2 | `VisualEditSession` in `core.mjs` | Versioned target/build-bound document, expected-revision gate, bounded history, Undo/Redo, local restore, failed render/storage rollback. History intentionally resets on reload |
| M3 | Independent [line-style-viewer #52](https://github.com/kinoko34077/line-style-viewer/issues/52) / [Draft PR #53](https://github.com/kinoko34077/line-style-viewer/pull/53) | Same module source mirrored temporarily, opt-in static shell targets, independent chat data/Undo smoke. This **does not** establish M5 package distribution |
| M4 | `model-adapter.mjs`, `model-adapter.test.mjs`, `react-scene.test.mjs` | Model-owned tree move/reparent, factory-only leaf duplicate, leaf delete, undo/redo, cycle/type/anchor validation, rollback; React server-render and scene projection follow the authoritative model |

`core.test.mjs` and `browser.test.mjs` exercise safe operations, conflicts, restoring styles after browser reload, regeneration of semantic DOM nodes and the live Frequency Warp app's preview-mode controls. Source code in `core/`, `vst3/`, `fwengine-*/` remains unchanged.

## Interface and lifecycle

```js
import {VisualEditSession} from './core.mjs';
import {createDomStyleAdapter} from './dom-adapter.mjs';
const target={appId:'my-app',routeId:'main',templateId:'layout',sourceRevision:'layout-v1'};
const adapter=createDomStyleAdapter({
  root:document.body,
  styleElement:document.head.appendChild(document.createElement('style')),
  target,
  allowedIds:['header.title']
});
const session=VisualEditSession.restore({target,adapter,storage:localStorage,storageKey:'my-app:layout:v1'});
await session.refresh();
await session.transact({expectedRevision:session.document.designRevision,operations:[
  {kind:'setStyle',nodeId:'header.title',property:'font-size',breakpoint:'base',value:'20px'}
]});
await session.undo();
```

Static adapter requires app-controlled `data-ve-id` to match each registered ID, unique within its root. It is intentionally **style-only**: it does not copy, detach, delete or reparent real controls. CSS `order` is denied unless the adapter explicitly permits visual-only order on safe noninteractive Flex/Grid siblings.

Model adapter usage:

```js
import {ModelLayoutSession} from './model-adapter.mjs';
const editor=new ModelLayoutSession({
  initialModel:layoutTree, // rootId/revision/nodes, validated parent-child topology
  commitModel:async next=>{ /* app owns this commit and subsequent re-render */ },
  factory:(source,newId)=>({ ...source,id:newId,children:[] }) // approved component factory
});
await editor.transact({expectedRevision:editor.model.revision,operations:[
  {kind:'move',nodeId:'label1',parentId:'panel',beforeId:'label2'}
]});
```

The callback is app-owned and must reject when its render/state projection cannot commit. Never use `cloneNode` to clone live React components or runtime-dependent controls. In model-tree pilot, **moving entire dynamic trees across React component owners, binding real content fields, and native Canvas hit-testing are not yet implemented**. Structural model test coverage does not prove physical DAW, React production integration, mobile Safari, or complex application-specific sound safety.

## M3 / M4 qualification boundaries

- M3 has genuine independent static-site code and GitHub CI, but all changes remain on non-releasing branches. The mirrored source is explicitly an interim evaluation copy; source-package publishing/deduplicated delivery is excluded under M5.
- M4 tests exercise a genuine React server renderer and a scene-graph projection through an app-owned model callback. They do **not** substitute for integrating an editing panel into a production React/Canvas application, or for browser device testing of a React build.
- The pure style session and structural model session have **separate histories** in the pilot. A fully unified cross-domain transaction graph is a future design decision, not silently claimed.
- Service Worker caching, full framework-level source reverse mapping, HTML/JSX export, hosted synchronization, cross-origin editing and library distribution are excluded from this iteration.

## Historical pre-release gate (completed/superseded)

At the M1–M4 checkpoint, [PR #163](https://github.com/kinoko34077/frequency-warp-vst/pull/163) and [LINE PR #53](https://github.com/kinoko34077/line-style-viewer/pull/53) were held as Draft pending exact-head CI, independent review and authorization. The M4-only instruction to STOP before M5 no longer represents an unfinished gate: M5 was subsequently authorized, implemented and released on verified main/Pages. Draft CI alone was not used as proof of public release.

## Historical M5 draft: reusable package and per-page strategy

At the draft checkpoint this folder contained a private `package.json` v0.5.0 and explicit `index.mjs` exports, with non-releasing consumer copies. The current accepted package is **v0.5.1**, distributed by reviewed pinned source copies (not npm/CDN). The versioned, capability-based design described below remains applicable; a separate package repository is not part of the accepted M5 scope.

`resolvePageProfile({target,ownership,sourceNodeMap,breakpoints,requiredOperations})` deterministically chooses static DOM / React-owned model / scene-owned model logic. Ownership and capabilities are provided by each page, not guessed from hosting, CSS or incidental DOM. Common algorithms stay shared; denied operations fail closed. Browser editor and React game model have distinct history owners.

`exportCss()` creates a validated stylesheet mapped to app-declared source IDs; `createSourceProposal()` emits a **review-only** CSS file/diff proposal, never an automatic repository write; `exportStaticHtml()` accepts only exact trusted static source and unique literal source IDs (no React/JSX reverse-mapping). Unsupported structure, dynamic source, stale revision and capability mismatches must be represented as explicit errors.

M5 owner [#175](https://github.com/kinoko34077/frequency-warp-vst/issues/175) is CLOSED/DONE; the historical pilot-only state was superseded by verified release. Cross-repo acceptance is recorded in [devflow #560](https://github.com/kinoko34077/devflow/issues/560).

## Patch source consistency (2026-10-15)

Private package v0.5.1 fixes static HTML export identity validation: `data-id`, attribute text, comments and script/style markup cannot stand in for a literal quoted HTML `id`. The accepted code change is FW [#187](https://github.com/kinoko34077/frequency-warp-vst/issues/187) / PR #188. Consumers LINE and Gomoku copy byte-identical shared source from a pinned accepted canonical commit and validate every blob hash offline. This is a reviewed source-only patch, not an npm publication or cross-origin editor.

Previous M1–M4 and M5 non-releasing Draft descriptions above are **historical pilot checkpoints**, not live release status. All three Pages sites, including Gomoku, have verified successful publication; the obsolete Pages permission blocker and subsequent favicon 404 are resolved. The accepted shared source/pin remains v0.5.1; current cross-repository tracking and performance evidence belong to [devflow #560](https://github.com/kinoko34077/devflow/issues/560).
