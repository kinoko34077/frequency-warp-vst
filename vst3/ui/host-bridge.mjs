// VST3/UI-1: browser-side protocol only. No audio processing or DAW API in JS.
// An unchanged Frequency Warp website may import this file when mounted by a
// trusted local WebView2 host. Without a host the page works as before.
export const PROTOCOL = "frequency-warp.host-ui.v1";
export const DEFAULT_BINDINGS = Object.freeze([
  { id: 2, selector: "#low", min: 0, max: 1000 },
  { id: 3, selector: "#high", min: 0, max: 1000 },
  { id: 4, selector: "#invert", min: 0, max: 1 },
  { id: 5, selector: "#curvature", min: 0, max: 1 }
]);

const validNormalized = n => Number.isFinite(n) && n >= 0 && n <= 1;
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const validBinding = b =>
  b && Number.isInteger(b.id) && b.id >= 0 && b.id < 128 &&
  typeof b.selector === "string" && /^#[A-Za-z][A-Za-z0-9_-]*$/.test(b.selector) &&
  Number.isFinite(b.min) && Number.isFinite(b.max) && b.max > b.min &&
  b.max - b.min < 1e12;
export function validateBindings(bindings) {
  if (!Array.isArray(bindings) || bindings.length > 128) return false;
  const ids = new Set(), selectors = new Set();
  for (const b of bindings) {
    if (!validBinding(b) || ids.has(b.id) || selectors.has(b.selector)) return false;
    ids.add(b.id); selectors.add(b.selector);
  }
  return true;
}
export function createHostUiBridge({ webview, document, bindings = DEFAULT_BINDINGS }) {
  if (!webview || typeof webview.postMessage !== "function" ||
      typeof webview.addEventListener !== "function" ||
      !document || typeof document.querySelector !== "function" ||
      !validateBindings(bindings)) throw new TypeError("Invalid trusted host UI bridge");
  let disposed = false, applying = false;
  const editing = new Set(), subscriptions = [];
  const controls = new Map();
  const generated = new Map();
  let generatedPanel = null;
  // Only VST3 host-confirmed, fixed generic IDs get a local DOM rail.
  // This UI is presentation only; native still gates all host DAW edits.
  function syncGeneratedControls(bindings) {
    if (typeof document.createElement !== "function" ||
        typeof document.body?.appendChild !== "function") return;
    const wanted = new Set(bindings
      .filter(b => b.id >= 64 && b.id <= 127 &&
                   b.selector === `#fw-engine-${b.id}`)
      .map(b => b.id));
    for (const [id, row] of generated) {
      if (wanted.has(id)) continue;
      row.remove();
      generated.delete(id);
    }
    if (wanted.size && !generatedPanel) {
      generatedPanel = document.createElement("section");
      generatedPanel.id = "fw-vst3-generic-panel";
      generatedPanel.setAttribute("aria-label", "Verified engine parameters");
      generatedPanel.style.cssText =
        "position:fixed;right:12px;bottom:12px;z-index:10000;" +
        "max-height:40vh;overflow:auto;padding:12px;" +
        "background:#161b24;color:white;border:1px solid #69717d;" +
        "border-radius:8px;font:12px system-ui;min-width:200px";
      document.body.appendChild(generatedPanel);
    }
    for (const id of wanted) {
      if (generated.has(id)) continue;
      const row = document.createElement("label");
      row.style.cssText = "display:flex;gap:8px;align-items:center;margin:6px";
      const title = document.createElement("span");
      title.textContent = `Engine Slot ${id}`;
      const input = document.createElement("input");
      input.id = `fw-engine-${id}`;
      input.type = "range";
      input.min = "0";input.max = "1";input.step = "any";input.value = "0.5";
      input.setAttribute("aria-label", `Verified Engine Slot ${id}`);
      row.appendChild(title);row.appendChild(input);
      generatedPanel.appendChild(row);
      generated.set(id, row);
    }
    if (!wanted.size && generatedPanel) {
      generatedPanel.remove();generatedPanel = null;
    }
  }
  function emit(kind, extra = {}) {
    if (!disposed) webview.postMessage({ protocol: PROTOCOL, kind, ...extra });
  }
  function end(id) {
    if (!editing.delete(id)) return;
    emit("edit-end", { id });
  }
  function begin(id) {
    if (editing.has(id)) return;
    editing.add(id);
    emit("edit-begin", { id });
  }
  function bindAll(newBindings) {
    if (!validateBindings(newBindings)) return false;
    for (const [node, kind, listener] of subscriptions) node.removeEventListener(kind, listener);
    subscriptions.length = 0;
    for (const id of editing) emit("edit-end", { id });
    editing.clear();
    controls.clear();
    syncGeneratedControls(newBindings);
    for (const b of newBindings) {
      const node = document.querySelector(b.selector);
      if (!node || !own(node, "value") && !("value" in node)) continue;
      controls.set(b.id, { node, binding: b });
      const perform = () => {
        if (disposed || applying) return;
        const physical = Number(node.value);
        if (!Number.isFinite(physical)) return;
        const value = (physical - b.min) / (b.max - b.min);
        if (!validNormalized(value)) return;
        begin(b.id);
        emit("edit-perform", { id: b.id, value });
      };
      const finish = () => { if (!disposed && !applying) end(b.id); };
      for (const [kind, listener] of [
        ["input", perform], ["change", finish], ["pointerup", finish],
        ["pointercancel", finish], ["blur", finish]
      ]) {
        node.addEventListener(kind, listener);
        subscriptions.push([node, kind, listener]);
      }
    }
    return true;
  }
  function applyValue(id, value) {
    const entry = controls.get(id);
    if (!entry || !validNormalized(value)) return false;
    const { node, binding: b } = entry;
    applying = true;
    try {
      node.value = String(b.min + value * (b.max - b.min));
      const win = document.defaultView;
      // Notify the EXISTING website listeners to redraw the rail/graph,
      // without emitting an automation echo into the host.
      node.dispatchEvent(new win.Event("input", { bubbles: true }));
      node.dispatchEvent(new win.Event("change", { bubbles: true }));
    } finally { applying = false; }
    return true;
  }
  function onMessage(event) {
    const msg = event?.data;
    if (disposed || !msg || typeof msg !== "object" ||
        msg.protocol !== PROTOCOL || typeof msg.kind !== "string") return;
    if (msg.kind === "parameter") {
      if (Number.isInteger(msg.id)) applyValue(msg.id, msg.value);
    } else if (msg.kind === "snapshot") {
      if (!msg.values || typeof msg.values !== "object" ||
          Array.isArray(msg.values)) return;
      for (const [id, value] of Object.entries(msg.values)) {
        if (/^(0|[1-9][0-9]{0,2})$/.test(id)) applyValue(Number(id), value);
      }
    } else if (msg.kind === "bindings") {
      // Descriptor requests from host are hints for HTML mapping only.
      // The NATIVE host remains authoritative for slot identity/semantics.
      if (bindAll(msg.bindings)) emit("bindings-ack", { count: controls.size });
    }
  }
  bindAll(bindings);
  webview.addEventListener("message", onMessage);
  emit("hello", { version: 1, visibleBindings: Array.from(controls.keys()) });
  return {
    applyValue,
    get visibleIds() { return Array.from(controls.keys()); },
    dispose() {
      if (disposed) return;
      for (const id of editing) emit("edit-end", { id });
      editing.clear();
      disposed = true;
      webview.removeEventListener?.("message", onMessage);
      for (const [node, kind, listener] of subscriptions) node.removeEventListener(kind, listener);
      subscriptions.length = 0; controls.clear();
      for (const row of generated.values()) row.remove();
      generated.clear();
      if (generatedPanel) generatedPanel.remove();
      generatedPanel = null;
    }
  };
}
