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
  const lifecycleListeners = [];
  const listen = (target, kind, handler) => {
    if (typeof target?.addEventListener !== "function") return;
    target.addEventListener(kind, handler);
    lifecycleListeners.push([target, kind, handler]);
  };
  const editing = new Set(), subscriptions = [];
  const controls = new Map();
  // VST3-only DOM controls mirror the NATIVE Controller's latest active
  // FWS3 mask. Browser metadata NEVER grants an edit: Win32 host rechecks
  // its worker+ticket-derived mask for every incoming edit event.
  const genericNodes = new Map();
  let genericPanel = null, genericKey = "";
  let bindingPanel = null, bindingStatus = null, bindingConfirm = null;
  function createBindingPanel() {
    if (typeof document.createElement !== "function" ||
        typeof document.body?.appendChild !== "function") return;
    bindingPanel = document.createElement("section");
    bindingPanel.id = "fw-vst-binding-panel";
    bindingPanel.style.cssText = "padding:10px;margin:8px;border:1px solid #777;" +
      "border-radius:8px;background:#1e1f24;color:#fff;font:13px system-ui";
    const heading = document.createElement("div");
    heading.textContent = "VST3 verified engine binding";
    bindingPanel.appendChild(heading);
    const select = document.createElement("button");
    select.textContent = "Select binding JSON";
    select.type = "button";
    listen(select, "click", () => emit("binding-select"));
    bindingPanel.appendChild(select);
    bindingConfirm = document.createElement("button");
    bindingConfirm.textContent = "Confirm binding";
    bindingConfirm.type = "button";
    bindingConfirm.disabled = true;
    listen(bindingConfirm, "click", () => {
      if (!bindingConfirm.disabled) emit("binding-confirm");
    });
    bindingPanel.appendChild(bindingConfirm);
    bindingStatus = document.createElement("div");
    bindingStatus.textContent = "No binding requested";
    bindingStatus.style.cssText = "min-height:2em;overflow-wrap:anywhere";
    bindingPanel.appendChild(bindingStatus);
    document.body.appendChild(bindingPanel);
  }
  function showBindingPhase(phase) {
    const messages = {
      idle: "No binding requested",
      preparing: "Worker verifying descriptor; nothing saved",
      confirm: "Worker prepared descriptor. Confirm to save FWS3",
      committing: "Commit queued; awaiting worker confirmation",
      accepted: "Binding saved and active",
      inactive: "Saved binding not currently authorized",
      rejected: "Binding rejected; existing audio preserved"
    };
    if (!Object.prototype.hasOwnProperty.call(messages, phase)) return;
    if (bindingStatus) bindingStatus.textContent = messages[phase];
    if (bindingConfirm) bindingConfirm.disabled = phase !== "confirm";
  }
  function syncNativeGenericSlots(ids) {
    if (!Array.isArray(ids) || ids.length > 64 ||
        !ids.every(id => Number.isInteger(id) && id >= 64 && id <= 127) ||
        new Set(ids).size !== ids.length) return false;
    const ordered = ids.slice().sort((a, b) => a - b);
    const key = ordered.join(",");
    if (key === genericKey) return true;
    if (typeof document.createElement !== "function" ||
        !document.body || typeof document.body.appendChild !== "function")
      return false;
    if (ordered.length && !genericPanel) {
      genericPanel = document.createElement("section");
      genericPanel.id = "fw-vst-generic-panel";
      genericPanel.style.cssText =
        "padding:10px;margin:8px;border:1px solid #777;border-radius:8px;" +
        "background:#1e1f24;color:#fff;font:13px system-ui";
      const heading = document.createElement("div");
      heading.textContent = "Verified engine parameters (normalized)";
      genericPanel.appendChild(heading);
      document.body.appendChild(genericPanel);
    }
    for (const [id, group] of genericNodes) {
      if (!ordered.includes(id)) {
        group.remove();
        genericNodes.delete(id);
      }
    }
    for (const id of ordered) if (!genericNodes.has(id)) {
      const group = document.createElement("label");
      group.style.cssText = "display:flex;gap:8px;align-items:center;margin:5px 0";
      group.textContent = `Engine Slot ${id}`;
      const input = document.createElement("input");
      input.id = `fw-vst-slot-${id}`;
      input.type = "range"; input.min = "0"; input.max = "1";
      input.step = "0.001"; input.value = "0.5";
      group.appendChild(input);
      genericPanel.appendChild(group);
      genericNodes.set(id, group);
    }
    if (!ordered.length && genericPanel) {
      genericPanel.remove();
      genericPanel = null;
    }
    const bindings = DEFAULT_BINDINGS.concat(ordered.map(id => ({
      id, selector: `#fw-vst-slot-${id}`, min: 0, max: 1
    })));
    if (!bindAll(bindings)) return false;
    genericKey = key;
    return true;
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
  function endAllGestures() { for (const id of Array.from(editing)) end(id); }
  function bindAll(newBindings) {
    if (!validateBindings(newBindings)) return false;
    for (const [node, kind, listener] of subscriptions) node.removeEventListener(kind, listener);
    subscriptions.length = 0;
    for (const id of editing) emit("edit-end", { id });
    editing.clear();
    controls.clear();
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
      // Generic slider visibility is derived solely from the native host
      // mask sent with this snapshot. Missing/unrecognized input never adds
      // new permissions. Actual edit authority remains native.
      if (own(msg, "genericSlots") && !syncNativeGenericSlots(msg.genericSlots))
        return;
      if (!msg.values || typeof msg.values !== "object" ||
          Array.isArray(msg.values)) return;
      for (const [id, value] of Object.entries(msg.values)) {
        if (/^(0|[1-9][0-9]{0,2})$/.test(id)) applyValue(Number(id), value);
      }
    } else if (msg.kind === "binding-state") {
      showBindingPhase(msg.phase);
    } else if (msg.kind === "bindings") {
      // Descriptor requests from host are hints for HTML mapping only.
      // The NATIVE host remains authoritative for slot identity/semantics.
      if (bindAll(msg.bindings)) emit("bindings-ack", { count: controls.size });
    }
  }
  bindAll(bindings);
  createBindingPanel();
  listen(document.defaultView, "blur", endAllGestures);
  listen(document, "visibilitychange", () => {
    if (document.hidden) endAllGestures();
  });
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
      for (const [node, kind, fn] of lifecycleListeners)
        node.removeEventListener(kind, fn);
      lifecycleListeners.length = 0;
      for (const node of genericNodes.values()) node.remove();
      genericNodes.clear();
      if (genericPanel) genericPanel.remove();
      genericPanel = null; genericKey = "";
      bindingPanel?.remove(); bindingPanel = null;
      bindingStatus = null; bindingConfirm = null;
    }
  };
}
