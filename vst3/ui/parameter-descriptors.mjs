// UI-4A / R1: pure, bounded descriptor validation and value transfer.
// UI metadata is never authority to alter a VST3 Host ParamID or WASM ABI.
// Audio/host permissions require a separately verified native binding (R2/R3).
import { UNIT_KINDS } from "../../web-demo/parameter-units.mjs";

export const SCHEMA = "frequency-warp-ui-descriptors-v1";
const idPattern = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)+$/;
const semanticPattern = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const shaPattern = /^[a-f0-9]{64}$/;
const selectorPattern = /^#[A-Za-z][A-Za-z0-9_-]*$/;
const widgets = new Set(["knob", "slider", "number", "select", "switch"]);
const scales = new Set(["linear", "log", "discrete", "frequency-band", "frequency-with-zero"]);
const unitsByDimension = Object.freeze({
  ...UNIT_KINDS,
  boolean: Object.freeze(["boolean"])
});
const canonicalByDimension = Object.freeze({
  frequency: "hz", ratio: "ratio", fraction: "fraction",
  signedRatio: "ratio", coordinate: "coordinate", integer: "integer",
  boolean: "boolean"
});
const isObject = x => x !== null && typeof x === "object" &&
  !Array.isArray(x) && Object.getPrototypeOf(x) === Object.prototype;
const hasExactly = (x, required, optional = []) => isObject(x) &&
  required.every(k => Object.hasOwn(x, k)) &&
  Object.keys(x).every(k => required.includes(k) || optional.includes(k));
const finite = x => typeof x === "number" && Number.isFinite(x);
const validSemantic = x => typeof x === "string" &&
  x.length <= 128 && semanticPattern.test(x);
const roundtripDomain = x => finite(x) && Math.abs(x) <= 1e9;
const unique = items => new Set(items).size === items.length;
function validateOne(b, engineId) {
  const required = ["host_slot", "semantic_id", "label", "dimension",
    "canonical_unit", "min", "max", "default", "scale", "widget",
    "display_units", "codec_revision"];
  const optional = ["snap", "selector", "steps", "depends_on"];
  if (!hasExactly(b, required, optional)) return false;
  if (!Number.isInteger(b.host_slot) || b.host_slot < 64 || b.host_slot > 127 ||
      !validSemantic(b.semantic_id) || b.semantic_id === engineId ||
      typeof b.label !== "string" || b.label.length < 1 || b.label.length > 64 ||
      !/^[^\u0000-\u001f\u007f]+$/.test(b.label) ||
      !Object.hasOwn(canonicalByDimension, b.dimension) ||
      b.canonical_unit !== canonicalByDimension[b.dimension] ||
      !roundtripDomain(b.min) || !roundtripDomain(b.max) ||
      !roundtripDomain(b.default) ||
      !(b.max > b.min) || b.default < b.min || b.default > b.max ||
      !scales.has(b.scale) || !widgets.has(b.widget) ||
      !Number.isInteger(b.codec_revision) || b.codec_revision < 1 ||
      b.codec_revision > 65535) return false;
  const allowed = unitsByDimension[b.dimension];
  if (!Array.isArray(b.display_units) || !b.display_units.length ||
      b.display_units.length > allowed.length ||
      !unique(b.display_units) || !b.display_units.every(u => allowed.includes(u))) return false;
  if (Object.hasOwn(b, "selector") &&
      (typeof b.selector !== "string" || !selectorPattern.test(b.selector))) return false;
  if (b.dimension === "frequency" && b.min < 0) return false;
  if (b.dimension === "ratio" && b.min <= 0) return false;
  if (b.dimension === "fraction" && (b.min < 0 || b.max > 1)) return false;
  if (b.dimension === "boolean" &&
      !(b.min === 0 && b.max === 1 && Number.isInteger(b.default) &&
        b.scale === "discrete" && b.steps === 1 && b.widget === "switch")) return false;
  if (b.dimension === "integer" &&
      (!Number.isInteger(b.min) || !Number.isInteger(b.max) ||
       !Number.isInteger(b.default) || b.scale !== "discrete")) return false;
  if (b.scale === "log" && b.min <= 0) return false;
  if (b.scale === "frequency-band" &&
      !(b.dimension === "frequency" && b.min === .001 && b.max === 20000)) return false;
  if (b.scale === "frequency-with-zero" &&
      !(b.dimension === "frequency" && b.min === 0 && b.max === 20000)) return false;
  if (Object.hasOwn(b, "steps") &&
      (!Number.isInteger(b.steps) || b.steps < 1 || b.steps > 65535)) return false;
  if (b.scale === "discrete" && !Object.hasOwn(b, "steps")) return false;
  if (b.scale !== "discrete" && Object.hasOwn(b, "steps")) return false;
  if (b.scale === "discrete" && b.dimension === "integer" &&
      b.steps !== b.max - b.min) return false;
  if (b.scale === "discrete" &&
      Math.abs((b.default-b.min)*b.steps/(b.max-b.min) -
        Math.round((b.default-b.min)*b.steps/(b.max-b.min))) > 1e-9) return false;
  if (Object.hasOwn(b, "snap")) {
    const s = b.snap;
    if (!hasExactly(s, ["values", "radius_normalized"]) ||
        !Array.isArray(s.values) || s.values.length < 1 || s.values.length > 32 ||
        !s.values.every(x => finite(x) && x >= b.min && x <= b.max) ||
        !unique(s.values) || !finite(s.radius_normalized) ||
        s.radius_normalized < 0 || s.radius_normalized > 0.25) return false;
  }
  if (Object.hasOwn(b, "depends_on") &&
      (!Array.isArray(b.depends_on) || b.depends_on.length > 16 ||
       !unique(b.depends_on) || !b.depends_on.every(validSemantic) ||
       b.depends_on.includes(b.semantic_id))) return false;
  return true;
}
export function validateDescriptors(packageData) {
  if (!hasExactly(packageData, ["schema", "engine", "bindings"]) ||
      packageData.schema !== SCHEMA ||
      !hasExactly(packageData.engine, ["id", "version", "sha256"]) ||
      !idPattern.test(packageData.engine.id ?? "") ||
      packageData.engine.id.length > 128 ||
      typeof packageData.engine.version !== "string" ||
      !/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?$/.test(packageData.engine.version) ||
      packageData.engine.version.length > 64 ||
      !shaPattern.test(packageData.engine.sha256 ?? "") ||
      !Array.isArray(packageData.bindings) || packageData.bindings.length > 64 ||
      !packageData.bindings.every(b => validateOne(b, packageData.engine.id))) return false;
  const bindings = packageData.bindings;
  if (!unique(bindings.map(b => b.host_slot)) ||
      !unique(bindings.map(b => b.semantic_id))) return false;
  const selectors = bindings.filter(b => b.selector).map(b => b.selector);
  if (!unique(selectors)) return false;
  const ids = new Set(bindings.map(b => b.semantic_id));
  if (!bindings.every(b => !b.depends_on || b.depends_on.every(id => ids.has(id)))) return false;
  // Bounded DFS detects circular (even indirect) parameter dependencies.
  const graph = new Map(bindings.map(b => [b.semantic_id, b.depends_on ?? []]));
  const state = new Map();
  function visit(id) {
    if (state.get(id) === 1) return false;
    if (state.get(id) === 2) return true;
    state.set(id, 1);
    if (!graph.get(id).every(visit)) return false;
    state.set(id, 2);
    return true;
  }
  return [...ids].every(visit);
}
export function parseDescriptors(json) {
  if (typeof json !== "string" || new TextEncoder().encode(json).byteLength > 65536)
    throw new RangeError("descriptor byte limit");
  let data;
  try { data = JSON.parse(json); } catch { throw new TypeError("invalid descriptor JSON"); }
  if (!validateDescriptors(data)) throw new RangeError("invalid descriptor contract");
  return data;
}
function norm01(n) {
  if (!finite(n) || n < 0 || n > 1) throw new RangeError("normalized value outside [0,1]");
  return n;
}
function checkedPhysical(b, x) {
  if (!finite(x) || x < b.min || x > b.max) throw new RangeError("canonical value out of bounds");
  return x;
}
const BAND_MIN = .001;
const LOG_20 = Math.log(20000);
const LOG_1000 = Math.log(1000);
function bandFromNorm(n) {
  return n <= .2 ? BAND_MIN*Math.exp(LOG_20*n/.2) :
    20*Math.exp(LOG_1000*(n-.2)/.8);
}
function normFromBand(h) {
  return h <= 20 ? .2*Math.log(h/BAND_MIN)/LOG_20 :
    .2+.8*Math.log(h/20)/LOG_1000;
}
function zeroFromNorm(n) {
  if (n === 0) return 0;
  return n <= .2 ?
    BAND_MIN*Math.exp(LOG_20*(Math.max(n,.001)*1000-1)/199) :
    20*Math.exp(LOG_1000*(n-.2)/.8);
}
function normFromZero(h) {
  if (h === 0) return 0;
  return h <= 20 ?
    (1+199*Math.log(h/BAND_MIN)/LOG_20)/1000 :
    .2+.8*Math.log(h/20)/LOG_1000;
}
// Pure deterministic mapping. Does not mutate the processor/host state.
export function toPhysical(b, normalized, applySnap=false) {
  if (!validateOne(b, "dummy.engine")) throw new TypeError("unvalidated descriptor");
  const n=norm01(normalized);
  let x;
  switch(b.scale) {
    case "log": x=b.min*Math.pow(b.max/b.min,n); break;
    case "discrete": x=b.min+(b.max-b.min)*Math.round(n*b.steps)/b.steps; break;
    case "frequency-band": x=bandFromNorm(n); break;
    case "frequency-with-zero": x=zeroFromNorm(n); break;
    default: x=b.min+(b.max-b.min)*n;
  }
  if (applySnap && b.snap) {
    let closest=null, distance=Infinity;
    for(const value of b.snap.values) {
      const d=Math.abs(toNormalized(b,value)-n);
      if(d<distance){closest=value;distance=d;}
    }
    if(distance<=b.snap.radius_normalized)x=closest;
  }
  return Math.max(b.min, Math.min(b.max,x));
}
export function toNormalized(b, physical) {
  if (!validateOne(b, "dummy.engine")) throw new TypeError("unvalidated descriptor");
  const p=checkedPhysical(b,physical);
  let n;
  switch(b.scale) {
    case "log": n=Math.log(p/b.min)/Math.log(b.max/b.min); break;
    case "discrete": n=Math.round(((p-b.min)/(b.max-b.min))*b.steps)/b.steps; break;
    case "frequency-band": n=normFromBand(p); break;
    case "frequency-with-zero": n=normFromZero(p); break;
    default: n=(p-b.min)/(b.max-b.min);
  }
  return Math.max(0,Math.min(1,n));
}
