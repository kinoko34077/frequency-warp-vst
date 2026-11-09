/** A/B view-state adapter. The Settings dialog is deliberately excluded.
 * DSP canonical values remain owned by the existing parameter bindings.
 */
export const COMPARISON_UNIT_SELECTS=Object.freeze([
  "low-unit","high-unit","pivot-unit","axis-slope-unit","axis-shift-unit",
  "carrier-unit","crusher-hold-unit","fundamental-unit","pitch-ratio-unit",
  "sine-unit"
]);
export const COMPARISON_SNAP_KEYS=Object.freeze(["low","high","pivot","slope","crusher","sine",
  "harmonic-fundamental","harmonic-carrier","harmonic-ratio"]);
export function captureComparisonView(root,{graphMax,sineFrequency,snaps}){
  const doc=root.ownerDocument;
  return {
    units:Object.fromEntries(COMPARISON_UNIT_SELECTS.map(id=>[id,doc.getElementById(id).value])),
    disclosures:[...root.querySelectorAll("details")].map(node=>node.open),
    ...(snaps?{snaps:{...snaps}}:{}),
    graph:{max:graphMax,log:Number(doc.getElementById("graph-log").value),
      tab:doc.getElementById("tab-math").getAttribute("aria-selected")==="true"?"math":"map"},
    sine:{frequency:sineFrequency,enabled:doc.getElementById("sine-enabled").checked,
      volume:Number(doc.getElementById("sine-volume").value)}
  };
}
export function validateComparisonView(root,view){
  if(!view||!view.units||!view.graph||!view.sine||
    !Array.isArray(view.disclosures))throw Error("Incomplete A/B interface view");
  const doc=root.ownerDocument;
  for(const id of COMPARISON_UNIT_SELECTS){
    const node=doc.getElementById(id);
    if(![...node.options].some(option=>option.value===view.units[id]))
      throw Error("Invalid interface unit "+id);
  }
  if(view.snaps && (typeof view.snaps!=="object"||
    COMPARISON_SNAP_KEYS.some(key=>typeof view.snaps[key]!=="boolean")))
    throw Error("Invalid A/B snap states");
  const details=[...root.querySelectorAll("details")];
  if(view.disclosures.length!==details.length||
    !view.disclosures.every(x=>typeof x==="boolean"))throw Error("Invalid A/B disclosure state");
  if(![20,2000,20000].includes(view.graph.max)||
    !Number.isFinite(view.graph.log)||view.graph.log<0||view.graph.log>100||
    !["map","math"].includes(view.graph.tab))throw Error("Invalid A/B graph view");
  if(!Number.isFinite(view.sine.frequency)||view.sine.frequency<=0||
    !Number.isFinite(view.sine.volume)||view.sine.volume<0||view.sine.volume>100||
    typeof view.sine.enabled!=="boolean")throw Error("Invalid A/B sine view");
  return view;
}
export function restoreComparisonView(root,view,{showTab,setGraph,restoreSine,restoreSnaps}){
  validateComparisonView(root,view);
  const doc=root.ownerDocument;
  for(const id of COMPARISON_UNIT_SELECTS){
    const node=doc.getElementById(id);
    if(node.value!==view.units[id]){
      node.value=view.units[id];
      node.dispatchEvent(new Event("change",{bubbles:true})); // unit-only, no DSP numeric write
    }
  }
  for(const [index,node] of [...root.querySelectorAll("details")].entries())
    node.open=view.disclosures[index];
  doc.getElementById("graph-log").value=String(view.graph.log);
  setGraph(view.graph.max);
  showTab(view.graph.tab);
  restoreSine(view.sine);
  if(view.snaps&&restoreSnaps)restoreSnaps(view.snaps);
}
