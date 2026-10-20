/** Purpose-first virtual fundamental interface.
 * Old harmonics-panel stays owned and untouched until the full V2/V3
 * acceptance/retirement gate. No speculation about hearing a theoretical H.
 */
import {createVirtualRootPlan,virtualRootStatus} from "./virtual-root-plan.mjs";
import {hzFromVirtualRootRail,virtualRootRailFromHz} from "./virtual-root-rail.mjs";
const $=id=>document.querySelector(id);
const number=id=>Number($("#"+id).value);
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
  // Static, trusted markup. An isolated module keeps the huge legacy Lab DOM
  // intact until all accepted feature/real-browser gates are satisfied.
  const root=$("#virtual-root-workbench");
  if(!root)return;
  root.innerHTML=`
    <div class="section-header"><div><p class="eyebrow">VIRTUAL FUNDAMENTAL</p><h2>倍音を配置する</h2></div></div>
    <p class="vr-intro">仮想基音の場所・番号の飛ばし幅・最初の番号から音の並びを作ります。バーは理論値であり、音源の実測ではありません。</p>
    <div class="vr-inputs">
      <label>元基音 F（Hz・手入力）<input id="vr-source-f" type="text" inputmode="decimal" value="350"></label>
      <label>配置方法<select id="vr-placement"><option value="target">仮想基音を自由に配置（間隔も変化）</option><option value="keep-spacing">元の倍音間隔を保持（Hは自動算出）</option></select></label>
      <label>仮想基音 H（Hz）<input id="vr-target-h" type="text" inputmode="decimal" value="87.5" aria-describedby="vr-status"><input id="vr-h-rail" type="range" min="0" max="1000" step="1" aria-label="仮想基音を正の周波数でドラッグ"><small id="vr-rail-note"></small></label>
      <label>倍音の並べ方<select id="vr-mode"><option value="series">一定間隔で並べる</option><option value="fold-to-root">0Hz折返しでHへ到達</option></select></label>
      <label>番号の間隔 m<input id="vr-step-m" type="number" min="1" max="64" step="1" value="4"></label>
      <label id="vr-first-field">最初の番号 h₁<input id="vr-first-index" type="number" min="1" max="129" step="1" value="1"></label>
      <label id="vr-fold-field" hidden>折返す元倍音 q<input id="vr-fold-q" type="number" min="1" max="32" step="1" value="1"></label>
    </div>
    <div class="vr-presets" role="group" aria-label="番号列の例">
      <button type="button" data-vr-preset="4:1">1・5・9…</button>
      <button type="button" data-vr-preset="4:3">3・7・11…</button>
      <button type="button" data-vr-preset="2:1">1・3・5…</button>
    </div>
    <p id="vr-summary" class="vr-summary" aria-live="polite"></p>
    <div id="vr-preview" class="vr-preview" role="list" aria-label="倍音の理論上の移動"></div>
    <div id="vr-formula" class="vr-formula"></div>
    <p id="vr-status" class="vr-status" aria-live="polite"></p>
    <button id="vr-apply" class="primary" type="button">この配置を音声設定へ適用</button>
    <p id="vr-audio-status" class="vr-audio-status" role="status" aria-live="polite">音声処理への反映は未確認です。</p>
    <small>0.001Hz未満でも理論値は保持。現在の音声処理で適用できない場合、0Hzにせず元の音声設定を保持します。</small>`;
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
    $("#vr-h-rail").disabled=keep;
    try{
      current=collect();
      if(keep)$("#vr-target-h").value=String(current.H);
      const rail=virtualRootRailFromHz(current.H);
      $("#vr-h-rail").value=String(rail.position);
      $("#vr-h-rail").setAttribute("aria-valuetext",String(current.H)+"Hz");
      $("#vr-rail-note").textContent=rail.limited?
        "ドラッグ範囲外。直接入力したHは丸めず保持します。":
        "0Hzを含まない対数レール（入力値は丸めません）";
      const plan=current;
      const hasH=plan.hasPhysicalRoot;
      summary.textContent="仮想基音 "+concise(plan.H)+" Hz ・ 間隔 "+
        plan.m+"番号 ・ "+(hasH?"Hそのものの部分音あり":"Hは番号を数える基準（実音としては未出現）");
      formula.replaceChildren(
        document.createTextNode("Δ = "),fractionOf(plan.fraction),
        document.createTextNode(" × F′ = "+concise(plan.shift)+" Hz （F′ = "+
          concise(plan.pitched)+" Hz、前段Pitch "+concise(plan.ratio)+"倍）")
      );
      const maxHz=Math.max(...plan.outputs.flatMap(x=>[x.source,x.output]),Number.MIN_VALUE);
      const fragment=document.createDocumentFragment();
      for(const row of plan.outputs){
        const el=document.createElement("div");el.className="vr-partial";el.setAttribute("role","listitem");
        if(row.atRoot)el.classList.add("at-virtual-root");
        if(row.reflected)el.classList.add("vr-is-reflected");
        const caption=document.createElement("div");caption.className="vr-partial-caption";
        caption.textContent="元の第"+row.k+"倍音 "+concise(row.source)+" Hz → "+
          (row.reflected?"負へ移動 "+concise(row.signed)+" Hz → 折返し ":"")+
          concise(row.output)+" Hz（番号"+row.gridIndex+
          (row.atRoot?"・仮想基音へ到達":"")+"）";
        const orig=document.createElement("div");orig.className="vr-partial-track vr-original-track";
        const originalBar=document.createElement("span");originalBar.className="vr-partial-bar vr-original-bar";
        originalBar.style.width=Math.max(1,Math.min(100,100*row.source/maxHz))+"%";
        orig.append(originalBar);
        const rail=document.createElement("div");rail.className="vr-partial-track";
        const bar=document.createElement("span");bar.className="vr-partial-bar";
        bar.style.width=Math.max(1,Math.min(100,100*row.output/maxHz))+"%";
        rail.append(bar);el.append(caption,orig,rail);fragment.append(el);
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
    $("#"+id).addEventListener("input",()=>{
      if(id==="vr-placement"&&placement()==="keep-spacing"){
        const F=number("vr-source-f"),m=number("vr-step-m");
        if(Number.isFinite(F)&&F>0&&m>=1)
          $("#vr-target-h").value=String(F/m);
      }
      appliedFingerprint=null;
      audio.textContent="配置を編集中。現在の表示値は音声へ未適用です。";
      audio.dataset.phase="edited";
      render();
    });
  $("#vr-h-rail").addEventListener("input",()=>{
    if(placement()!=="target")return;
    $("#vr-target-h").value=String(hzFromVirtualRootRail(number("vr-h-rail")));
    appliedFingerprint=null;render();
  });
  document.querySelectorAll("[data-vr-preset]").forEach(button=>
    button.addEventListener("click",()=>{
      const [m,h1]=button.dataset.vrPreset.split(":").map(Number);
      $("#vr-mode").value="series";$("#vr-step-m").value=String(m);
      $("#vr-first-index").value=String(h1);
      appliedFingerprint=null;
      audio.textContent="番号列を編集中。音声には未適用です。";
      audio.dataset.phase="edited";
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
    const previous=onCurrent?.();
    if(previous && Number.isFinite(previous.F) && previous.F>0 &&
       Number.isInteger(previous.m) && previous.m>=1 && previous.m<=64 &&
       Number.isFinite(previous.r) && previous.r>0){
      const H=previous.r*previous.F/previous.m;
      const q=previous.q;
      const folded=Number.isSafeInteger(q) && q>=1 && q<=32 &&
        previous.n===-(q*previous.m+1);
      const first=previous.m+previous.n;
      // If the existing sound is a valid sparse series or selected fold,
      // restore its exact coordinates rather than displaying an unrelated
      // draft after A/B load or Reset.
      if(folded || (Number.isSafeInteger(first)&&first>=1&&first<=129)){
        $("#vr-source-f").value=String(previous.F);
        $("#vr-target-h").value=String(H);
        $("#vr-step-m").value=String(previous.m);
        $("#vr-fold-q").value=String(q);
        $("#vr-first-index").value=String(folded?1:first);
        $("#vr-mode").value=folded?"fold-to-root":"series";
        $("#vr-placement").value="target";
      }
    }
    render();
    audio.textContent="別画面の加工設定を表示中。再生中のDSP反映は別途確認してください。";
    audio.dataset.phase="external";
  });
  render();
}
