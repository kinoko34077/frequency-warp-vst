/** Purpose-first virtual fundamental interface.
 * Old harmonics-panel stays owned and untouched until the full V2/V3
 * acceptance/retirement gate. No speculation about hearing a theoretical H.
 */
import {createVirtualRootPlan,virtualRootStatus} from "./virtual-root-plan.mjs";
const $=id=>document.querySelector(id);
const number=id=>Number($(id).value);
const concise=v=>v===0?"0":Number.isFinite(v)?(
  Math.abs(v)<.001?Number(v.toPrecision(8)).toString():
  Number(v.toFixed(3)).toString()):"—";
function fractionOf({n,m}){
  const root=document.createElement("span");
  root.className="vr-fraction";
  root.setAttribute("role","math");
  root.setAttribute("aria-label",n+" / "+m);
  for(const [cls,value] of [["vr-numerator",n],["vr-denominator",m]]){
    const part=document.createElement("span");
    part.className=cls;part.textContent=String(value);root.append(part);
  }
  return root;
}
export function mountVirtualRootWorkbench({onApply,onCurrent}){
  const inputs=["vr-source-f","vr-target-h","vr-step-m","vr-first-index","vr-fold-q"];
  const foldField=$("#vr-fold-field"),startField=$("#vr-first-field");
  const preview=$("#vr-preview"),status=$("#vr-status"),audio=$("#vr-audio-status");
  const apply=$("#vr-apply"),formula=$("#vr-formula"),summary=$("#vr-summary");
  let current=null,appliedFingerprint=null;
  const mode=()=>$("#vr-mode").value;
  const placement=()=>$("#vr-placement").value;
  const collect=()=>createVirtualRootPlan({
    F:number("vr-source-f"),H:number("vr-target-h"),m:number("vr-step-m"),
    h1:number("vr-first-index"),q:number("vr-fold-q"),
    mode:mode(),placement:placement(),count:8
  });
  function render(){
    foldField.hidden=mode()!=="fold-to-root";
    startField.hidden=mode()==="fold-to-root";
    const keep=placement()==="keep-spacing";
    $("#vr-target-h").readOnly=keep;
    $("#vr-target-h").setAttribute("aria-readonly",String(keep));
    try{
      current=collect();
      if(keep)$("#vr-target-h").value=String(current.H);
      const plan=current;
      const hasH=plan.hasPhysicalRoot;
      summary.textContent="仮想基音 "+concise(plan.H)+" Hz ・ 間隔 "+
        plan.m+"番号 ・ "+(hasH?"Hそのものの部分音あり":"Hは番号を数える基準（実音としては未出現）");
      formula.replaceChildren(
        document.createTextNode("Δ = "),fractionOf(plan.fraction),
        document.createTextNode(" × F′ = "+concise(plan.shift)+" Hz （F′ = "+
          concise(plan.pitched)+" Hz、前段Pitch "+concise(plan.ratio)+"倍）")
      );
      const maxHz=Math.max(...plan.outputs.map(x=>x.output),Number.MIN_VALUE);
      const fragment=document.createDocumentFragment();
      for(const row of plan.outputs){
        const el=document.createElement("div");el.className="vr-partial";
        if(row.atRoot)el.classList.add("at-virtual-root");
        if(row.reflected)el.classList.add("vr-is-reflected");
        const caption=document.createElement("div");caption.className="vr-partial-caption";
        caption.textContent="元の第"+row.k+"倍音 "+concise(row.source)+" Hz → "+
          (row.reflected?"負へ移動 "+concise(row.signed)+" Hz → 折返し ":"")+
          concise(row.output)+" Hz（番号"+row.gridIndex+
          (row.atRoot?"・仮想基音へ到達":"")+"）";
        const rail=document.createElement("div");rail.className="vr-partial-track";
        const bar=document.createElement("span");bar.className="vr-partial-bar";
        bar.style.width=Math.max(1,Math.min(100,100*row.output/maxHz))+"%";
        rail.append(bar);el.append(caption,rail);fragment.append(el);
      }
      preview.replaceChildren(fragment);
      status.textContent=virtualRootStatus(plan);
      status.dataset.state=plan.capability.rationalStage?"ready":"theory";
      apply.disabled=!plan.capability.rationalStage;
      if(!plan.capability.rationalStage){
        appliedFingerprint=null;
        audio.textContent="音声には未適用です。現在の音声設定は保持されます。";
      }
    }catch(error){
      current=null;apply.disabled=true;
      status.textContent="数値を確認してください："+error.message;
      status.dataset.state="invalid";
      summary.textContent="入力中。正しい値になるまで直前の音声設定を保持します。";
      preview.replaceChildren();formula.replaceChildren();
      audio.textContent="直前の音声設定を保持中";
    }
  }
  function refreshAudio(){
    if(!appliedFingerprint)return;
    const original=$("#harmonic-apply-evidence");
    const phase=original?.dataset.phase||"unknown";
    audio.textContent=phase==="applied"?"音声エンジン反映済（ACK）":
      phase==="pending"?"DSP反映を確認中…":
      "音声反映状態："+(original?.textContent?.trim()||"未確認");
    audio.dataset.phase=phase;
  }
  for(const id of [...inputs,"vr-mode","vr-placement"])
    $(id).addEventListener("input",()=>{
      if(id==="vr-placement"&&placement()==="keep-spacing"){
        const F=number("vr-source-f"),m=number("vr-step-m");
        if(Number.isFinite(F)&&F>0&&m>=1)
          $("#vr-target-h").value=String(F/m);
      }
      appliedFingerprint=null;
      render();
    });
  document.querySelectorAll("[data-vr-preset]").forEach(button=>
    button.addEventListener("click",()=>{
      const [m,h1]=button.dataset.vrPreset.split(":").map(Number);
      $("#vr-mode").value="series";$("#vr-step-m").value=String(m);
      $("#vr-first-index").value=String(h1);
      render();
    })
  );
  apply.addEventListener("click",()=>{
    if(!current||!current.capability.rationalStage)return;
    try{
      onApply(current);
      appliedFingerprint=current;
      audio.textContent="音声エンジンへ設定を要求。ACK確認前は適用済みとは表示しません。";
      audio.dataset.phase="pending";
      refreshAudio();
    }catch(error){
      audio.textContent="音声設定へ未反映："+error.message;
      audio.dataset.phase="rejected";
    }
  });
  const evidence=$("#harmonic-apply-evidence");
  if(evidence){
    const observer=new MutationObserver(refreshAudio);
    observer.observe(evidence,{childList:true,subtree:true,characterData:true,
      attributes:true,attributeFilter:["data-phase"]});
  }
  // On A/B restore or global reset, avoid falsely presenting old draft data
  // as the currently active DSP configuration. The next V3 step will migrate
  // workbench mode/preset metadata into the canonical A/B snapshot.
  document.addEventListener("fw:virtual-root-external-change",()=>{
    appliedFingerprint=null;
    audio.textContent="他の画面で加工設定が変更されました。ここで再適用できます。";
    onCurrent?.();render();
  });
  render();
}
