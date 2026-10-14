import {deriveHarmonics} from "./harmonics.mjs";

// The entire panel is a UI adapter. Spectral mapping and Fold frequency
// resolve through core/src/lib.rs compiled to the shared Rust/WASM artifact.
const $=id=>document.querySelector(id);
const precision=()=>Number($("#decimal-digits")?.value||3);
const fmt=value=>Number.isFinite(value)?Number(value.toFixed(precision())).toString():"—";
const IDS=["fundamental","denominator","numerator","harmonic-index","pitch-ratio","carrier"];
const integerFields=new Set(["denominator","numerator","harmonic-index"]);
const preciseFields=new Map();
const round3=v=>Math.round((v+Number.EPSILON)*1000)/1000;
const read=id=>preciseFields.has(id)?preciseFields.get(id):Number($("#"+id).value);
const clamp=(v,min,max)=>Math.min(max,Math.max(min,v));
const carrierHzFromSlider=step=>step<=0?0:Math.exp(Math.log(20000)*(step-1)/999);
const sliderFromCarrierHz=hz=>hz<=0?0:1+999*Math.log(clamp(hz,1,20000))/Math.log(20000);

export function linkedCarrierRequested(){
  return $("#carrier-link").checked;
}
export function harmonicParameters(){
  const F=clamp(read("fundamental")||350,20,2000);
  const m=clamp(Math.round(Number($("#denominator").value)||4),1,64);
  const n=clamp(Math.round(Number($("#numerator").value)||0),-128,128);
  const q=clamp(Math.round(Number($("#harmonic-index").value)||1),1,32);
  const r=clamp(read("pitch-ratio")||1,.25,4);
  const manualCarrier=clamp(read("carrier")||0,0,20000);
  const foldMode=["fold-l","fold-h"].includes($("#mode").value);
  return {F,m,n,q,r,c:linkedCarrierRequested()&&foldMode?-1:manualCarrier,
    manualCarrier,linked:linkedCarrierRequested()&&foldMode};
}
function syncPair(id){
  const number=$("#"+id),range=$("#"+id+"-range");
  if(!number||!range)return;
  const parsed=read(id);
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
export function renderHarmonicPanel(foldPoint,axisMarker,resolveSettings){
  const {F,m,n,q,r,manualCarrier,linked}=harmonicParameters();
  const count=Number($("#harmonic-count").value)||5;
  const z=deriveHarmonics(F,m,n,q,r,count);
  const c=resolvedCarrierHz(foldPoint);
  const movedH=axisMarker?.(z.H);
  const moving=Number.isFinite(movedH)?fmt(movedH)+" Hz":"未算出";
  const actual=resolveSettings?.();
  const axis=actual?.curvature??Number($("#curvature").value);
  const shift=actual?.axisShift??Number($("#axis-shift").value);
  const axisName=axis===0?"対数／倍率":axis===1?"線形／一定Hz":"中間座標";
  $("#math-axis-note").textContent="仮想基音： "+fmt(z.H)+" Hz → "+moving;
  const variables=[
    ["F · 元基音",fmt(F)+" Hz"],["r · ピッチ比",fmt(r)],
    ["F′ · 基音",fmt(r*F)+" Hz"],["m · 間隔",String(m)],
    ["n · 番号ずれ",String(n)],["q · 折返す倍音",String(q)],
    ["H · 仮想基音",fmt(z.H)+" Hz"],["Δ · 番号移動",fmt(z.delta)+" Hz"],
    ["S · 折返し量",fmt(z.foldShift)+" Hz"],["c · リング搬送波",fmt(c)+" Hz"]
  ];
  const populate=(id,rows)=>{
    const node=$(id),fragment=document.createDocumentFragment();
    for(const [name,value] of rows){
      const dt=document.createElement("dt"),dd=document.createElement("dd");
      dt.textContent=name;dd.textContent=value;
      fragment.append(dt,dd);
    }
    node.replaceChildren(fragment);
  };
  populate("#math-variables",variables);
  const pivot=actual?.axisPivot??(Number($("#axis-pivot-value").value)||0);
  populate("#coordinate-details",[
    ["起点",fmt(pivot)+" Hz"],
    ["傾き",fmt(actual?.axisSlope??Number($("#axis-slope").value))+" 倍"],
    ["対数移動倍率",fmt(Math.exp(shift))+" 倍"],
    ["線形移動量",fmt(shift*r*F)+" Hz"],
    ["反転率",fmt(100*(actual?.invert??Number($("#invert").value)))+" %"],
    ["移動の尺度",axisName],
    ["備考","移動0なら起点が固定。上下移動を指定すると起点も移動します。"]
  ]);
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
  $("#mini-fundamental").textContent=fmt(z.H)+" → "+moving;
  $("#mini-harmonics").replaceChildren(...z.rows.slice(0,3).map(row=>{
    const div=document.createElement("div");
    const shifted=axisMarker?.(row.translated);
    div.textContent=row.k+"： "+fmt(row.input)+" → "+fmt(Number.isFinite(shifted)?shifted:row.translated)+" Hz";
    return div;
  }));
  $("#harmonic-table-title").textContent="第1〜"+count+"倍音の数値表を見る";
  const checkbox=$("#carrier-link"),readout=$("#carrier-linked-value");
  const valid=["fold-l","fold-h"].includes($("#mode").value);
  for(const node of [$("#carrier"),$("#carrier-range")])node.disabled=checkbox.checked&&valid;
  if(!checkbox.checked){
    readout.textContent="オフ：手動 "+fmt(manualCarrier)+" Hz";
  }else if(!valid){
    readout.textContent="この補間には移動する折返し点がありません。手動 "+fmt(manualCarrier)+" Hzを使用";
  }else{
    const fold=foldPoint?.();
    readout.textContent=Number.isFinite(fold)?
      "入力側の折返し点 = "+fmt(fold)+" Hzへ連動（Rust共通DSP）":
      "折返し点を共通DSPから読込み中…";
  }
  return z;
}
export function attachHarmonicPanel(onChange,foldPoint,axisMarker,resolveSettings){
  const respond=id=>{renderHarmonicPanel(foldPoint,axisMarker,resolveSettings);onChange(id);};
  for(const id of IDS){
    const number=$("#"+id),range=$("#"+id+"-range");
    // Preserve direct typing for exact values while making typical changes
    // a one-finger drag; invalid numbers are clamped on change.
    range.addEventListener("input",()=>{
      preciseFields.delete(id);
      number.value=id==="carrier"?String(Math.round(carrierHzFromSlider(Number(range.value)))):range.value;
      respond(id);
    });
    number.addEventListener("focus",()=>{
      if(preciseFields.has(id))number.value=String(preciseFields.get(id));
      number.select();
    });
    number.addEventListener("input",()=>{
      if(number.value===""||!Number.isFinite(Number(number.value)))return;
      const value=clamp(Number(number.value),Number(number.min),Number(number.max));
      preciseFields.set(id,integerFields.has(id)?Math.round(value):round3(value));
      syncPair(id);respond(id);
    });
    number.addEventListener("change",()=>{
      const min=Number(number.min),max=Number(number.max);
      const raw=Number(number.value);
      const v=Number.isFinite(raw)&&number.value!==""?clamp(raw,min,max):Number(number.defaultValue);
      const stored=integerFields.has(id)?Math.round(v):round3(v);
      preciseFields.set(id,stored);
      // A range is approximate; retain the exact typed 3-decimal value.
      syncPair(id);respond(id);
    });
    number.addEventListener("blur",()=>{
      const value=read(id);
      if(Number.isFinite(value))number.value=integerFields.has(id)?
        String(value):String(Number(value.toFixed(precision())));
    });
    syncPair(id);
  }
  $("#carrier-link").addEventListener("change",()=>respond("carrier-link"));
  $("#harmonic-count").addEventListener("change",()=>renderHarmonicPanel(foldPoint,axisMarker,resolveSettings));
  renderHarmonicPanel(foldPoint,axisMarker,resolveSettings);
}
