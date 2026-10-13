import {deriveHarmonics} from "./harmonics.mjs";

// The entire panel is a UI adapter. Spectral mapping and Fold frequency
// resolve through core/src/lib.rs compiled to the shared Rust/WASM artifact.
const $=id=>document.querySelector(id);
const fmt=value=>Number.isFinite(value)?Number(value.toFixed(2)).toString():"—";
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
  $("#math-axis-note").textContent="仮想基音 "+fmt(z.H)+" Hz → "+moving+"（"+axisName+"）";

  // Equations are actual MathML, descriptions and current values are a
  // separate semantic table: no literal escaped newline, pipes or code dump.
  const math=(body)=>'<math xmlns="http://www.w3.org/1998/Math/MathML" display="block">'+body+'</math>';
  const formulas=[
    ["仮想基音",math('<mi>H</mi><mo>=</mo><mfrac><mrow><mi>r</mi><mi>F</mi></mrow><mi>m</mi></mfrac>')],
    ["倍音の移動",math('<msub><mi>f</mi><mi>k</mi></msub><mo>=</mo><mo>(</mo><mi>m</mi><mi>k</mi><mo>+</mo><mi>n</mi><mo>)</mo><mi>H</mi>')],
    ["加算シフト",math('<mi>Δ</mi><mo>=</mo><mi>n</mi><mi>H</mi>')],
    ["折返しの基準",math('<mi>S</mi><mo>=</mo><mo>(</mo><mi>q</mi><mo>+</mo><mfrac><mn>1</mn><mi>m</mi></mfrac><mo>)</mo><mi>r</mi><mi>F</mi>')],
    ["リング変調",math('<mi>cos</mi><mo>(</mo><mi>a</mi><mo>)</mo><mi>cos</mi><mo>(</mo><mi>b</mi><mo>)</mo><mo>=</mo><mfrac><mn>1</mn><mn>2</mn></mfrac><mo>[</mo><mi>cos</mi><mo>(</mo><mi>a</mi><mo>+</mo><mi>b</mi><mo>)</mo><mo>+</mo><mi>cos</mi><mo>(</mo><mi>a</mi><mo>−</mo><mi>b</mi><mo>)</mo><mo>]</mo>')]
  ];
  $("#math-results").innerHTML='<div class="formula-grid">'+
    formulas.map(([title,markup])=>'<div class="formula-card"><strong>'+title+'</strong>'+markup+'</div>').join("")+
    '</div><table class="variable-table"><caption>記号と現在値</caption><thead><tr><th>記号</th><th>意味</th><th>値</th></tr></thead><tbody>'+
    [
      ["F","元の基音",fmt(F)+" Hz"],["r","倍率",fmt(r)],
      ["m","倍音の間隔",fmt(m)],["n","番号の移動",fmt(n)],
      ["q","折返す倍音",fmt(q)],["H","仮想基音",fmt(z.H)+" Hz"],
      ["Δ","一定Hz移動",fmt(z.delta)+" Hz"],["S","折返し基準",fmt(z.foldShift)+" Hz"],
      ["c","搬送波",fmt(c)+" Hz"]
    ].map(([sym,desc,val])=>'<tr><th scope="row">'+sym+'</th><td>'+desc+'</td><td>'+val+'</td></tr>').join("")+
    '</tbody></table><p class="math-note">数式は入力を整数倍音と仮定した例です。非線形変換後の録音音声が整数倍音になる保証はありません。</p>';

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
