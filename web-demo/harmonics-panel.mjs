import {deriveHarmonics} from "./harmonics.mjs";

// The entire panel is a UI adapter. Spectral mapping and Fold frequency
// resolve through core/src/lib.rs compiled to the shared Rust/WASM artifact.
const $=id=>document.querySelector(id);
const fmt=value=>Number.isFinite(value)?Number(value.toFixed(3)).toString():"—";
const IDS=["fundamental","denominator","numerator","harmonic-index","pitch-ratio","carrier"];
const integerFields=new Set(["denominator","numerator","harmonic-index"]);
const clamp=(v,min,max)=>Math.min(max,Math.max(min,v));
const carrierHzFromSlider=step=>step<=0?0:Math.exp(Math.log(20000)*(step-1)/999);
const sliderFromCarrierHz=hz=>hz<=0?0:1+999*Math.log(clamp(hz,1,20000))/Math.log(20000);

export function linkedCarrierRequested(){
  return $("#carrier-link").checked;
}
export function harmonicParameters(){
  const F=clamp(Number($("#fundamental").value)||350,20,2000);
  const m=clamp(Math.round(Number($("#denominator").value)||4),1,64);
  const n=clamp(Math.round(Number($("#numerator").value)||0),-128,128);
  const q=clamp(Math.round(Number($("#harmonic-index").value)||1),1,32);
  const r=clamp(Number($("#pitch-ratio").value)||1,.25,4);
  const manualCarrier=clamp(Number($("#carrier").value)||0,0,20000);
  const foldMode=$("#mode").value!=="blend";
  return {F,m,n,q,r,c:linkedCarrierRequested()&&foldMode?-1:manualCarrier,
    manualCarrier,linked:linkedCarrierRequested()&&foldMode,zeroMode:Number($("#zero-mode").value)};
}
function syncPair(id){
  const number=$("#"+id),range=$("#"+id+"-range");
  if(!number||!range)return;
  const parsed=Number(number.value);
  if(Number.isFinite(parsed)){
    const bounded=clamp(parsed,Number(number.min),Number(number.max));
    range.value=String(id==="carrier"?Math.round(sliderFromCarrierHz(bounded)):bounded);
  }
}
export function resolvedCarrierHz(foldPoint){
  const p=harmonicParameters();
  if(p.linked){
    const v=foldPoint?.();
    if(Number.isFinite(v))return v;
  }
  return p.manualCarrier;
}
export function renderHarmonicPanel(foldPoint,axisMarker){
  const {F,m,n,q,r,manualCarrier,linked}=harmonicParameters();
  const count=Number($("#harmonic-count").value)||7;
  const z=deriveHarmonics(F,m,n,q,r,count);
  const c=resolvedCarrierHz(foldPoint);
  const movedH=axisMarker?.(z.H);
  const moving=Number.isFinite(movedH)?fmt(movedH)+" Hz":"未算出";
  const axis=Number($("#curvature").value),shift=Number($("#axis-shift").value);
  const axisName=axis===0?"対数／倍率":axis===1?"線形／一定Hz":"中間座標";
  $("#math-axis-note").textContent="仮想基音 H="+fmt(z.H)+
    " Hz → 上下移動後 "+moving+
    "（"+axisName+"、移動量 "+(shift>=0?"+":"")+shift.toFixed(2)+"）";

  $("#math-results").textContent=[
    "入力の仮想格子: F′=rF="+fmt(r*F)+" Hz / H=F′/m="+fmt(z.H)+" Hz",
    "上下移動後のH位置マーカー = "+moving+"（必ずしも倍音列の公約数ではない）",
    "有理数シフト: Δ = (n/m)F′ = "+fmt(z.delta)+" Hz",
    "有理数格子: f′k = (mk+n)H = rkF+Δ",
    "処理順: Warp g(f) → 任意の有理数変換 → C_p軸で上下移動",
    "0Hz折返し: f′k = |krF − S|",
    "第q倍音がHへ: S=(q+1/m)rF = "+fmt(z.foldShift)+" Hz",
    "Ring Mod: cos(2πft)cos(2πct) = ½cos(2π(f+c)t)+½cos(2π(f−c)t)",
    "搬送波 c = "+fmt(c)+" Hz / 両側波帯 f+c, |f−c|",
    "変換順: Pitch→Shift = r·f+Δ / Shift→Pitch = r·(f+Δ)",
    "注: 移動後のHは位置マーカーです。純粋な一定Hz移動では倍音格子の真の共通基音と異なり得ます。"
  ].join("\n");
  const frag=document.createDocumentFragment();
  for(const row of z.rows){
    const tr=document.createElement("tr");
    for(const value of [row.k,row.input,row.translated,row.reflected,row.number]){
      const td=document.createElement("td");
      td.textContent=fmt(value);tr.appendChild(td);
    }
    frag.appendChild(tr);
  }
  $("#harmonics-body").replaceChildren(frag);
  $("#mini-fundamental").textContent="H "+fmt(z.H)+" → "+moving+" / Δ "+fmt(z.delta)+" Hz";
  $("#mini-harmonics").replaceChildren(...z.rows.slice(0,3).map(row=>{
    const div=document.createElement("div");
    const shifted=axisMarker?.(row.translated);
    div.textContent="第"+row.k+"倍音 "+fmt(row.input)+" → "+fmt(Number.isFinite(shifted)?shifted:row.translated)+" Hz";
    return div;
  }));
  $("#harmonic-table-title").textContent="第1〜"+count+"倍音の数値表を見る";
  const checkbox=$("#carrier-link"),readout=$("#carrier-linked-value");
  const valid=$("#mode").value!=="blend";
  for(const node of [$("#carrier"),$("#carrier-range")])node.disabled=checkbox.checked&&valid;
  if(!checkbox.checked){
    readout.textContent="オフ：手動 "+fmt(manualCarrier)+" Hz";
  }else if(!valid){
    readout.textContent="単純補間には折返し点がありません。手動 "+fmt(manualCarrier)+" Hzを使用";
  }else{
    const fold=foldPoint?.();
    readout.textContent=Number.isFinite(fold)?
      "入力側の折返し点 = "+fmt(fold)+" Hzへ連動（Rust共通DSP）":
      "折返し点を共通DSPから読込み中…";
  }
  return z;
}
export function attachHarmonicPanel(onChange,foldPoint,axisMarker){
  const respond=id=>{renderHarmonicPanel(foldPoint,axisMarker);onChange(id);};
  for(const id of IDS){
    const number=$("#"+id),range=$("#"+id+"-range");
    // Preserve direct typing for exact values while making typical changes
    // a one-finger drag; invalid numbers are clamped on change.
    range.addEventListener("input",()=>{
      number.value=id==="carrier"?String(Math.round(carrierHzFromSlider(Number(range.value)))):range.value;
      respond(id);
    });
    number.addEventListener("input",()=>{
      if(number.value===""||!Number.isFinite(Number(number.value)))return;
      syncPair(id);respond(id);
    });
    number.addEventListener("change",()=>{
      const min=Number(number.min),max=Number(number.max);
      const raw=Number(number.value);
      const v=Number.isFinite(raw)&&number.value!==""?clamp(raw,min,max):Number(number.defaultValue);
      const step=Number(number.step)||1;
      number.value=String(integerFields.has(id)?Math.round(v):Math.round(v/step)*step);
      syncPair(id);respond(id);
    });
    syncPair(id);
  }
  $("#carrier-link").addEventListener("change",()=>respond("carrier-link"));
  $("#harmonic-count").addEventListener("change",()=>renderHarmonicPanel(foldPoint,axisMarker));
  renderHarmonicPanel(foldPoint,axisMarker);
}
