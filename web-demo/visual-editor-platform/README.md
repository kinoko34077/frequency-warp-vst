# Cross-site Visual Editor — M1–M4 pilot runtime

**Status:** implementation pilot on branch `feat/web-generic-visual-editor-m1-m4-20261015`. Owning [#161](https://github.com/kinoko34077/frequency-warp-vst/issues/161), cross-repo [devflow #560](https://github.com/kinoko34077/devflow/issues/560), design candidate [#154](https://github.com/kinoko34077/frequency-warp-vst/issues/154). **Draft only; not a public feature, supported library release, or completed M5.**

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

## Required gate before any public rollout

Keep [PR #163](https://github.com/kinoko34077/frequency-warp-vst/pull/163) and [LINE PR #53](https://github.com/kinoko34077/line-style-viewer/pull/53) as Draft until exact-head CI, separate review and applicable release authorization. Published Pages remain on existing accepted main. Never infer that CI success in a draft branch means live production verification.

**Global phase rule:** after M4 pilot evidence and durable state reconciliation, **STOP** rather than starting M5 implicitly.
