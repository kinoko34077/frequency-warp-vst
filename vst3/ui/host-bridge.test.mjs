import test from "node:test";
import assert from "node:assert/strict";
import { PROTOCOL, DEFAULT_BINDINGS, createHostUiBridge, validateBindings } from "./host-bridge.mjs";

class FakeNode {
  constructor(value, registry = null) {
    this.value = String(value); this.listeners = new Map(); this.renderCount = 0;
    this.children = []; this.registry = registry; this.style = {}; this.parent = null;
  }
  appendChild(child) {
    this.children.push(child); child.parent = this;
    if (child.id) this.registry?.set(`#${child.id}`, child);
    return child;
  }
  remove() {
    if (this.parent) this.parent.children = this.parent.children.filter(x => x !== this);
    if (this.id) this.registry?.delete(`#${this.id}`);
    for (const c of [...this.children]) c.remove();
    this.children = []; this.parent = null;
  }
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
  const windowListeners = new Map(), documentListeners = new Map();
  const add = (registry, kind, fn) => {
    if (!registry.has(kind)) registry.set(kind, new Set());
    registry.get(kind).add(fn);
  };
  const remove = (registry, kind, fn) => registry.get(kind)?.delete(fn);
  const document = {
    hidden: false,
    addEventListener(kind, fn) { add(documentListeners, kind, fn); },
    removeEventListener(kind, fn) { remove(documentListeners, kind, fn); },
    fire(kind) { for (const fn of documentListeners.get(kind) ?? []) fn(); },
    body: new FakeNode("", nodes),
    createElement() { return new FakeNode("", nodes); },
    querySelector(selector) { return nodes.get(selector) ?? null; },
    defaultView: {
      addEventListener(kind, fn) { add(windowListeners, kind, fn); },
      removeEventListener(kind, fn) { remove(windowListeners, kind, fn); },
      fire(kind) { for (const fn of windowListeners.get(kind) ?? []) fn(); },
      Event: class { constructor(type, options) {
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

test("native worker-approved generic slots appear, never echo, and revoke dynamically", () => {
  const x = fixture();
  const bridge = createHostUiBridge(x);
  x.webview.deliver({ protocol: PROTOCOL, kind: "snapshot",
    genericSlots: [64, 65], values: { "64": 0.25, "65": 0.8 } });
  assert.deepEqual(bridge.visibleIds, [2, 3, 4, 5, 64, 65]);
  assert.equal(x.nodes.get("#fw-vst-slot-64").value, "0.25");
  assert.equal(x.nodes.get("#fw-vst-slot-65").value, "0.8");
  assert.equal(x.posted.length, 1); // host-to-DOM updates never echo automation
  const slider = x.nodes.get("#fw-vst-slot-64");
  slider.value = "0.6";
  slider.fire("input");
  assert.deepEqual(x.posted.slice(-2), [
    { protocol: PROTOCOL, kind: "edit-begin", id: 64 },
    { protocol: PROTOCOL, kind: "edit-perform", id: 64, value: 0.6 }
  ]);
  // A revoked native ticket removes both sliders and terminates the
  // incomplete gesture; a detached node cannot send any further edits.
  x.webview.deliver({ protocol: PROTOCOL, kind: "snapshot",
    genericSlots: [], values: {} });
  assert.deepEqual(bridge.visibleIds, [2, 3, 4, 5]);
  assert.equal(x.nodes.has("#fw-vst-slot-64"), false);
  assert.deepEqual(x.posted.at(-1),
    { protocol: PROTOCOL, kind: "edit-end", id: 64 });
  const count = x.posted.length;
  slider.fire("input");
  assert.equal(x.posted.length, count);
  // Malformed native slot lists never unlock generic controls.
  x.webview.deliver({ protocol: PROTOCOL, kind: "snapshot",
    genericSlots: [64, 64], values: { "64": 0.9 } });
  assert.deepEqual(bridge.visibleIds, [2, 3, 4, 5]);
  bridge.dispose();
});

test("native binding picker and explicit confirmation never send file paths or ticket data", () => {
  const x = fixture();
  const bridge = createHostUiBridge(x);
  const panel = x.nodes.get("#fw-vst-binding-panel");
  assert.equal(panel?.children.length, 4);
  const [heading, select, confirm, status] = panel.children;
  assert.equal(heading.textContent, "VST3 verified engine binding");
  assert.equal(confirm.disabled, true);
  select.fire("click");
  assert.deepEqual(x.posted.at(-1), { protocol: PROTOCOL, kind: "binding-select" });
  assert.equal(x.posted.length, 2);
  x.webview.deliver({ protocol: PROTOCOL, kind: "binding-state", phase: "confirm" });
  assert.equal(confirm.disabled, false);
  confirm.fire("click");
  assert.deepEqual(x.posted.at(-1), { protocol: PROTOCOL, kind: "binding-confirm" });
  x.webview.deliver({ protocol: PROTOCOL, kind: "binding-state", phase: "committing" });
  assert.equal(confirm.disabled, true);
  confirm.fire("click");
  assert.equal(x.posted.length, 3);
  x.webview.deliver({ protocol: PROTOCOL, kind: "binding-state", phase: "accepted" });
  assert.match(status.textContent, /saved and active/);
  bridge.dispose();
  select.fire("click");
  assert.equal(x.posted.length, 3);
});
test("window blur and document visibility loss end active edits without duplicates", () => {
  const x = fixture(), bridge = createHostUiBridge(x);
  x.webview.deliver({ protocol: PROTOCOL, kind: "snapshot",
    genericSlots: [64], values: { "64": 0.4 } });
  const slider = x.nodes.get("#fw-vst-slot-64");
  slider.value = "0.7"; slider.fire("input");
  x.document.defaultView.fire("blur");
  x.document.defaultView.fire("blur");
  assert.deepEqual(x.posted.slice(-3), [
    { protocol: PROTOCOL, kind: "edit-begin", id: 64 },
    { protocol: PROTOCOL, kind: "edit-perform", id: 64, value: 0.7 },
    { protocol: PROTOCOL, kind: "edit-end", id: 64 }
  ]);
  slider.fire("input");
  x.document.hidden = true;
  x.document.fire("visibilitychange");
  assert.equal(x.posted.at(-1).kind, "edit-end");
  const count = x.posted.length;
  bridge.dispose();
  x.document.defaultView.fire("blur");
  x.document.fire("visibilitychange");
  assert.equal(x.posted.length, count);
});
