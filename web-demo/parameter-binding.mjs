/** #79 Declarative parameter binding and rail-aware snap contract.
 * Independent of DOM, native host IDs, and Rust DSP. The underlying canonical
 * Float64 value must never be rewritten on a display-unit selection.
 */
import {
  compatibleUnits, parseView, formatView, ratioToSemitones,
  semitonesToRatio
} from "./parameter-units.mjs";

const finite = value => typeof value === "number" && Number.isFinite(value);
const requireFinite = (value, name) => {
  if (!finite(value)) throw new RangeError(name+" must be finite");
  return value;
};
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));

// Unit metadata does not own a parameter's limits/defaults/slider transfer.
export const UNIT_REGISTRY = Object.freeze({
  hz: Object.freeze({label:"Hz", dimension:"frequency", snapAxis:"hz"}),
  note: Object.freeze({label:"音名＋セント", dimension:"frequency", snapAxis:"midi"}),
  percent: Object.freeze({label:"%", dimension:"rail", snapAxis:"rail", requiresRail:true}),
  ratio: Object.freeze({label:"倍", dimension:"ratio-or-slope", snapAxis:"canonical"}),
  semitones: Object.freeze({label:"半音", dimension:"ratio", snapAxis:"semitones"}),
  cents: Object.freeze({label:"cent", dimension:"ratio", snapAxis:"cents"}),
  coordinate: Object.freeze({label:"座標", dimension:"coordinate", snapAxis:"canonical"}),
  integer: Object.freeze({label:"整数", dimension:"integer", snapAxis:"canonical"})
});

/** A rail maps canonical values to normalized physical positions, [0,1].
 * A discontinuous special value (e.g. pivot 0 Hz) must be handled by its
 * caller-provided rail functions, never by treating % as percentage of Hz.
 */
export function defineParameter({id, min, max, defaultValue, units, rail,
    digits=3, snap=null}) {
  const compatible = compatibleUnits(id); // typed authority from #77
  requireFinite(min, "min"); requireFinite(max, "max");
  requireFinite(defaultValue, "defaultValue");
  if (min >= max || defaultValue < min || defaultValue > max)
    throw new RangeError("invalid parameter bounds/default");
  if (!Number.isInteger(digits) || digits < 0 || digits > 12)
    throw new RangeError("digits must be 0..12");
  if (!Array.isArray(units) || units.length === 0 || new Set(units).size !== units.length ||
      units.some(unit => !compatible.includes(unit) || !UNIT_REGISTRY[unit]))
    throw new RangeError("invalid units for parameter");
  if (rail !== undefined && (typeof rail?.toPosition !== "function" ||
      typeof rail?.fromPosition !== "function"))
    throw new TypeError("rail requires toPosition and fromPosition");
  if (units.includes("percent") && !rail)
    throw new RangeError("percentage requires the parameter's actual rail transfer");
  let snapConfig = null;
  if (snap != null) {
    const {unit, mode, step, origin=0, targets, thresholdPx=6, enabled=true,
      during=["slider"]} = snap;
    if (typeof enabled !== "boolean") throw new TypeError("snap enabled must be boolean");
    if (!units.includes(unit)) throw new RangeError("snap unit must be enabled for this parameter");
    if (!rail) throw new RangeError("snap needs physical rail transfer");
    if (!finite(thresholdPx) || thresholdPx < 0)
      throw new RangeError("snap thresholdPx must be nonnegative");
    if (!Array.isArray(during) || during.some(v => !["slider", "typed"].includes(v)) ||
        new Set(during).size !== during.length)
      throw new RangeError("invalid snap input modes");
    if (mode === "step") {
      if (!finite(step) || step <= 0 || !finite(origin))
        throw new RangeError("step snap needs positive step and finite origin");
    } else if (mode === "targets") {
      if (!Array.isArray(targets) || !targets.length || targets.some(v => !finite(v)))
        throw new RangeError("targets snap needs numeric target values");
    } else throw new RangeError("unknown snap mode");
    snapConfig = Object.freeze({unit, mode, step, origin, enabled,
      targets:targets ? Object.freeze([...targets]) : undefined,
      thresholdPx, during:Object.freeze([...during])});
  }
  return Object.freeze({id, min, max, defaultValue, units:Object.freeze([...units]),
    rail:rail ? Object.freeze({toPosition:rail.toPosition,fromPosition:rail.fromPosition}) : null,
    digits, snap:snapConfig});
}

function toSnapCoordinate(value, unit, descriptor) {
  if (unit === "note") {
    if (value <= 0) return NaN; // no pitch representation for 0 Hz
    return 69 + 12 * Math.log2(value / 440);
  }
  if (unit === "semitones" || unit === "cents")
    return ratioToSemitones(value) * (unit === "cents" ? 100 : 1);
  if (unit === "percent") return descriptor.rail.toPosition(value) * 100;
  return value;
}
function fromSnapCoordinate(value, unit, descriptor) {
  if (unit === "note") return 440 * 2 ** ((value - 69) / 12);
  if (unit === "semitones" || unit === "cents")
    return semitonesToRatio(value / (unit === "cents" ? 100 : 1));
  if (unit === "percent") return descriptor.rail.fromPosition(value / 100);
  return value;
}
function checkedRailPosition(descriptor, value) {
  const pos = requireFinite(descriptor.rail.toPosition(value), "rail position");
  if (pos < -1e-9 || pos > 1+1e-9)
    throw new RangeError("rail coordinate must be within [0,1]");
  return clamp(pos, 0, 1);
}

/** Snap by actual pixel distance, NOT raw Hz/cent distance.
 * Nearby grid values are separately projected onto the physical rail.
 */
export function snappedValue(descriptor, value, {origin="slider", railPixels}={}) {
  requireFinite(value, "value");
  const spec = descriptor.snap;
  if (!spec || !spec.enabled || !spec.during.includes(origin)) return value;
  if (!finite(railPixels) || railPixels <= 0)
    throw new RangeError("snapping requires positive railPixels");
  const rawPos = checkedRailPosition(descriptor, value);
  const coord = toSnapCoordinate(value, spec.unit, descriptor);
  if (!finite(coord)) return value;
  const candidates = spec.mode === "targets" ? spec.targets : (() => {
    const index = (coord - spec.origin) / spec.step;
    if (!finite(index)) return [];
    return [Math.floor(index), Math.ceil(index)].map(k => spec.origin + k * spec.step);
  })();
  let best = value, nearestPx = Infinity;
  for (const target of candidates) {
    const numeric = fromSnapCoordinate(target, spec.unit, descriptor);
    if (!finite(numeric) || numeric < descriptor.min || numeric > descriptor.max) continue;
    const pixelDistance = Math.abs(checkedRailPosition(descriptor, numeric) - rawPos) * railPixels;
    if (pixelDistance < nearestPx) {nearestPx = pixelDistance; best = numeric;}
  }
  return nearestPx <= spec.thresholdPx ? best : value;
}

/** State-mutating operations notify at most once per user action.
 * notify:false supports derivations (e.g. H<->P) controlled by an outer event.
 */
export function createParameterBinding(descriptor, {initialValue=descriptor.defaultValue,
    initialUnit=descriptor.units[0], onChange=()=>{}}={}) {
  if (!descriptor?.id || typeof onChange !== "function")
    throw new TypeError("invalid descriptor or callback");
  if (!descriptor.units.includes(initialUnit)) throw new RangeError("invalid initial unit");
  let canonical = requireFinite(initialValue, "initialValue"), unit = initialUnit;
  if (canonical < descriptor.min || canonical > descriptor.max)
    throw new RangeError("initial value outside bounds");
  let notifying = false;
  const commit = (next, {origin="program", notify=true, snap=false,
      railPixels, overflow="clamp"}={}) => {
    if (notifying) throw new Error("reentrant parameter update");
    requireFinite(next, "parameter value");
    if (!["clamp", "reject"].includes(overflow)) throw new RangeError("invalid overflow policy");
    if (overflow === "reject" && (next < descriptor.min || next > descriptor.max))
      throw new RangeError("parameter value outside bounds");
    next = clamp(next, descriptor.min, descriptor.max);
    if (snap) next = snappedValue(descriptor, next, {origin, railPixels});
    if (Object.is(next, canonical)) return canonical;
    const previous = canonical;
    canonical = next;
    if (notify) {
      notifying = true;
      try {onChange(Object.freeze({id:descriptor.id, value:canonical, previous, origin}));}
      finally {notifying = false;}
    }
    return canonical;
  };
  return Object.freeze({
    get value(){return canonical;},
    get unit(){return unit;},
    get descriptor(){return descriptor;},
    selectUnit(nextUnit){
      if (!descriptor.units.includes(nextUnit)) throw new RangeError("incompatible unit");
      unit = nextUnit; // never rounds/reassigns canonical DSP state
      return unit;
    },
    display(digits=descriptor.digits){
      return formatView(canonical, unit, {
        id:descriptor.id, digits,
        toRail:descriptor.rail?.toPosition
      });
    },
    setCanonical:commit,
    setView(raw, {unit:inputUnit=unit, snap=false, railPixels,
        overflow="clamp", notify=true, origin="typed"}={}){
      if (!descriptor.units.includes(inputUnit)) throw new RangeError("incompatible unit");
      if (typeof raw !== "string" && typeof raw !== "number") throw new TypeError("invalid input type");
      if (!String(raw).trim()) throw new RangeError("empty input");
      const next = parseView(raw, inputUnit, {
        id:descriptor.id, fromRail:descriptor.rail?.fromPosition
      });
      return commit(next,{origin,notify,snap,railPixels,overflow});
    },
    setPosition(pos,{railPixels,notify=true,snap=true,origin="slider"}={}) {
      if (!descriptor.rail) throw new RangeError("parameter has no physical rail");
      requireFinite(pos,"slider position");
      if (pos < 0 || pos > 1) throw new RangeError("slider position outside [0,1]");
      return commit(descriptor.rail.fromPosition(pos),{origin,notify,snap,railPixels});
    },
    reset({notify=true}={}) {return commit(descriptor.defaultValue,{origin:"reset",notify});}
  });
}
