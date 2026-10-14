/** #77 Shared pure unit adapter: store only DSP canonical numbers.
 * Percent means normalized slider position (never percent of frequency). */
const NOTES=["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"];
const finite=x=>typeof x==="number"&&Number.isFinite(x);
export const UNIT_KINDS=Object.freeze({
 frequency:Object.freeze(["hz","note","percent"]),
 ratio:Object.freeze(["ratio","semitones","cents","percent"]),
 fraction:Object.freeze(["percent"]),
 signedRatio:Object.freeze(["ratio","percent"]),
 coordinate:Object.freeze(["coordinate","percent"]),
 integer:Object.freeze(["integer","percent"])
});
export const PARAMETER_KIND=Object.freeze({
 low:"frequency",high:"frequency","axis-pivot":"frequency",fundamental:"frequency",
 carrier:"frequency","a-min":"frequency","sine-hz":"frequency",
 "pitch-ratio":"ratio","axis-slope":"signedRatio",
 invert:"fraction",curvature:"fraction","zero-reflect":"fraction",
 "zero-decay":"fraction",wet:"fraction","a-reverb":"fraction",
 "graph-log":"fraction","a-quality":"fraction",
 "axis-shift":"coordinate","crusher-bits":"integer","a-band":"integer",
 denominator:"integer",numerator:"integer","harmonic-index":"integer"
});
export function compatibleUnits(parameter){
 const kind=PARAMETER_KIND[parameter];if(!kind)throw RangeError("unknown parameter");
 return UNIT_KINDS[kind];
}
export function noteCentsToHz(note,reference=440){
 if(!finite(reference)||reference<=0)throw RangeError("invalid tuning");
 const match=/^\s*([A-Ga-g])([#♯b♭]?)(-?\d+)(?:\s*([+-])\s*(\d+(?:\.\d+)?)\s*c?)?\s*$/.exec(String(note));
 if(!match)throw RangeError("音名は A4, C#4+25c, Bb3-12.5c の形式");
 const base={C:0,D:2,E:4,F:5,G:7,A:9,B:11}[match[1].toUpperCase()];
 const accidental=["#","♯"].includes(match[2])?1:["b","♭"].includes(match[2])?-1:0;
 const cents=match[4]?(match[4]==="-"?-1:1)*Number(match[5]):0;
 const midi=12*(Number(match[3])+1)+base+accidental+cents/100;
 const hz=reference*Math.pow(2,(midi-69)/12);
 if(!finite(hz)||hz<=0)throw RangeError("pitch outside numeric range");
 return hz;
}
export function hzToNoteCents(hz,digits=2,reference=440){
 if(!finite(hz)||hz<=0||!finite(reference)||reference<=0)throw RangeError("pitch requires positive Hz");
 const midi=69+12*Math.log2(hz/reference),m=Math.round(midi),oct=Math.floor(m/12)-1;
 const cents=Number(((midi-m)*100).toFixed(digits));
 return NOTES[((m%12)+12)%12]+oct+(cents===0?"":(cents>0?"+":"")+cents+"c");
}
export const semitonesToRatio=s=>Math.pow(2,s/12);
export function ratioToSemitones(r){
 if(!finite(r)||r<=0)throw RangeError("ratio must be positive");
 return 12*Math.log2(r);
}
export function parseView(value,unit,{id,fromRail}={}){
 if(id&&!compatibleUnits(id).includes(unit))throw RangeError("unit incompatible with parameter");
 if(unit==="note")return noteCentsToHz(value);
 const x=Number(String(value).trim().replace(/(?:Hz|%|c)$/i,""));
 if(!finite(x))throw RangeError("invalid numeric value");
 if(unit==="percent"){
  if(x<0||x>100||typeof fromRail!=="function")throw RangeError("percent needs slider scale");
  return fromRail(x/100);
 }
 if(unit==="semitones"||unit==="cents")return semitonesToRatio(x/(unit==="cents"?100:1));
 return x;
}
export function formatView(value,unit,{id,toRail,digits=3}={}){
 if(id&&!compatibleUnits(id).includes(unit))throw RangeError("unit incompatible with parameter");
 if(!finite(value))throw RangeError("invalid canonical number");
 if(unit==="note")return hzToNoteCents(value,digits);
 if(unit==="percent"){
  if(typeof toRail!=="function")throw RangeError("percent needs slider scale");
  return Number((100*toRail(value)).toFixed(digits));
 }
 if(unit==="semitones"||unit==="cents")
  return Number((ratioToSemitones(value)*(unit==="cents"?100:1)).toFixed(digits));
 return Number(value.toFixed(digits));
}
