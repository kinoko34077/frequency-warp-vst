import {deriveHarmonics} from "./harmonics.mjs";
const $=id=>document.querySelector(id);
const h=v=>Number.isFinite(v)?Number(v.toFixed(3)).toString():"—";
function clampInt(v,lo,hi,fallback){return Number.isFinite(Number(v))?Math.max(lo,Math.min(hi,Math.trunc(Number(v)))):fallback;}
export function harmonicParameters(){
  return {
    F:Math.max(20,Math.min(2000,Number($("#fundamental").value)||350)),
    m:clampInt($("#denominator").value,1,64,4),
    n:clampInt($("#numerator").value,-128,128,0),
    q:clampInt($("#harmonic-index").value,1,32,1),
    r:Math.max(.25,Math.min(4,Number($("#pitch-ratio").value)||1)),
    c:Math.max(0,Math.min(20000,Number($("#carrier").value)||0)),
    zeroMode:Number($("#zero-mode").value)
  };
}
export function renderHarmonicPanel(){
  const {F,m,n,q,r,c}=harmonicParameters();
  const z=deriveHarmonics(F,m,n,q,r);
  $("#math-results").textContent=[
    "仮想基音 H = F / m = "+h(z.H)+" Hz",
    "有理数シフト Δ = (n/m) F = "+h(z.delta)+" Hz",
    "倍音列: f′k = (mk+n)(F/m) = kF+Δ",
    "Pitch → Frequency: f′ = r·f + Δ",
    "0Hzで折返し: f′k = |kF − S|",
    "第q倍音がHへ着地: S = (q+1/m)F = "+h(z.foldShift)+" Hz",
    "Ring Mod: cos(2πft)cos(2πct) = ½cos(2π(f+c)t)+½cos(2π(f−c)t)",
    "Ring搬送周波数 c = "+h(c)+" Hz",
    "Pitch→Shift は r·f+Δ / Shift→Pitch は r·(f+Δ)",
    "F/mは理論的な格子。実際に聴こえる音高／録音から検出した値とは異なります。"
  ].join("\n");
  const frag=document.createDocumentFragment();
  for(const row of z.rows){
    const tr=document.createElement("tr");
    for(const value of [row.k,row.input,row.translated,row.reflected,row.number]){
      const td=document.createElement("td");td.textContent=h(value);tr.appendChild(td);
    }
    frag.appendChild(tr);
  }
  $("#harmonics-body").replaceChildren(frag);
  return z;
}
export function attachHarmonicPanel(onSettingsChanged){
  for(const id of ["fundamental","denominator","numerator","harmonic-index","pitch-ratio","carrier","zero-mode"]){
    $("#"+id).addEventListener("input",()=>{
      renderHarmonicPanel();
      onSettingsChanged(id);
    });
  }
  renderHarmonicPanel();
}
