import test from "node:test";
import assert from "node:assert/strict";
import { PROTOCOL, DEFAULT_BINDINGS, createHostUiBridge, validateBindings } from "./host-bridge.mjs";

class FakeNode {
  constructor(value) { this.value = String(value); this.listeners = new Map(); this.renderCount = 0; }
  addEventListener(kind, fn) {
    if (!this.listeners.has(kind)) this.listeners.set(kind, new Set());
    this.listeners.get(kind).add(fn);
  }
  removeEventListener(kind, fn) { this.listeners.get(kind)?.delete(fn); }
  dispatchEvent(event) {
    for (const fn of this.listeners.get(event.type) ?? []) fn(event);
  }
  fire(kind) { this.dispatchEvent({ type: kind }); }
}
function fixture() {
  const nodes = new Map([
    ["#low", new FakeNode(200)], ["#high", new FakeNode(1000)],
    ["#invert", new FakeNode(0)], ["#curvature", new FakeNode(1)],
    ["#gain", new FakeNode(50)]
  ]);
  const listeners = new Map(), posted = [];
  const webview = {
    postMessage(message) { posted.push(message); },
    addEventListener(kind, fn) { listeners.set(kind, fn); },
    removeEventListener(kind, fn) { if (listeners.get(kind) === fn) listeners.delete(kind); },
    deliver(data) { listeners.get("message")?.({ data }); }
  };
  const document = {
    querySelector(selector) { return nodes.get(selector) ?? null; },
    defaultView: { Event: class { constructor(type, options) {
      this.type = type; this.bubbles = options?.bubbles;
    } } }
  };
  return { nodes, webview, document, posted };
}
test("v1 protocol enforces bounded, distinct fixed ParamIDs and selectors", () => {
  assert.ok(validateBindings(DEFAULT_BINDINGS));
  assert.equal(validateBindings([{ id: 128, selector: "#gain", min: 0, max: 1 }]), false);
  assert.equal(validateBindings([{ id: 4, selector: "#gain:hover", min: 0, max: 1 }]), false);
  assert.equal(validateBindings([{ id: 4, selector: "#x", min: 1, max: 0 }]), false);
  assert.equal(validateBindings([
    { id: 4, selector: "#a", min: 0, max: 1 },
    { id: 4, selector: "#b", min: 0, max: 1 }
  ]), false);
});
test("actual website rail changes generate one DAW begin/perform/end transaction", () => {
  const x = fixture();
  const bridge = createHostUiBridge(x);
  assert.deepEqual(bridge.visibleIds, [2, 3, 4, 5]);
  assert.deepEqual(x.posted[0], { protocol: PROTOCOL, kind: "hello", version: 1,
    visibleBindings: [2, 3, 4, 5] });
  x.nodes.get("#invert").value = "0.25";
  x.nodes.get("#invert").fire("input");
  x.nodes.get("#invert").value = "0.75";
  x.nodes.get("#invert").fire("input");
  x.nodes.get("#invert").fire("change");
  x.nodes.get("#invert").fire("pointerup");
  assert.deepEqual(x.posted.slice(1), [
    { protocol: PROTOCOL, kind: "edit-begin", id: 4 },
    { protocol: PROTOCOL, kind: "edit-perform", id: 4, value: 0.25 },
    { protocol: PROTOCOL, kind: "edit-perform", id: 4, value: 0.75 },
    { protocol: PROTOCOL, kind: "edit-end", id: 4 }
  ]);
  bridge.dispose();
});
test("host snapshot updates original DOM graph handlers but never echoes automation", () => {
  const x = fixture();
  let changes = 0;
  x.nodes.get("#low").addEventListener("input", () => { changes++; });
  const bridge = createHostUiBridge(x);
  x.webview.deliver({ protocol: PROTOCOL, kind: "snapshot",
    values: { "2": 0.41, "3": 0.92, "4": 0.5, "999": 0.25, evil: 0.5 } });
  assert.equal(x.nodes.get("#low").value, "410");
  assert.equal(x.nodes.get("#high").value, "920");
  assert.equal(x.nodes.get("#invert").value, "0.5");
  assert.equal(changes, 1);
  assert.equal(x.posted.length, 1);
  x.webview.deliver({ protocol: "untrusted", kind: "parameter", id: 4, value: 1 });
  x.webview.deliver({ protocol: PROTOCOL, kind: "parameter", id: 4, value: Number.NaN });
  x.webview.deliver({ protocol: PROTOCOL, kind: "parameter", id: 4, value: 10 });
  assert.equal(x.nodes.get("#invert").value, "0.5");
  bridge.dispose();
});
test("binding swap detaches old listeners; new host generic slot stays explicit", () => {
  const x = fixture();
  const bridge = createHostUiBridge(x);
  x.webview.deliver({ protocol: PROTOCOL, kind: "bindings", bindings: [
    { id: 64, selector: "#gain", min: 0, max: 100 }
  ] });
  assert.deepEqual(bridge.visibleIds, [64]);
  assert.deepEqual(x.posted.at(-1), { protocol: PROTOCOL, kind: "bindings-ack", count: 1 });
  const previousLength = x.posted.length;
  x.nodes.get("#invert").fire("input");
  assert.equal(x.posted.length, previousLength);
  x.nodes.get("#gain").value = "75";
  x.nodes.get("#gain").fire("input");
  x.nodes.get("#gain").fire("blur");
  assert.deepEqual(x.posted.slice(-3), [
    { protocol: PROTOCOL, kind: "edit-begin", id: 64 },
    { protocol: PROTOCOL, kind: "edit-perform", id: 64, value: 0.75 },
    { protocol: PROTOCOL, kind: "edit-end", id: 64 }
  ]);
  x.webview.deliver({ protocol: PROTOCOL, kind: "bindings",
    bindings: [{ id: 128, selector: "#gain", min: 0, max: 100 }] });
  assert.deepEqual(bridge.visibleIds, [64]);
  bridge.dispose();
});
test("out-of-range edits do not emit; disposal closes active automation exactly once", () => {
  const x = fixture();
  const bridge = createHostUiBridge(x);
  x.nodes.get("#curvature").value = "2";
  x.nodes.get("#curvature").fire("input");
  assert.equal(x.posted.length, 1);
  x.nodes.get("#curvature").value = "0.4";
  x.nodes.get("#curvature").fire("input");
  bridge.dispose();
  bridge.dispose();
  assert.deepEqual(x.posted.slice(-3), [
    { protocol: PROTOCOL, kind: "edit-begin", id: 5 },
    { protocol: PROTOCOL, kind: "edit-perform", id: 5, value: 0.4 },
    { protocol: PROTOCOL, kind: "edit-end", id: 5 }
  ]);
  x.nodes.get("#curvature").fire("input");
  assert.equal(x.posted.length, 4);
});
