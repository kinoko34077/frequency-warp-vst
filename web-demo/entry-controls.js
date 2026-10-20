/** Small entry controls do not depend on the large audio/WASM module graph.
 * Settings and the native <input type=file> must remain discoverable even if
 * a DSP module or deployment resource fails to load.
 */
(()=>{
  const $=id=>document.querySelector(id);
  // Compatibility switch for the original #16 equation-heavy Lab.
  // The legacy graph math and listeners remain in source, but the default
  // workspace now has a task-first virtual root editor. No data migration.
  if(new URL(location.href).searchParams.get("legacy_lab")==="1")
    document.documentElement.dataset.legacyHarmonics="1";
  const dialog=$("#settings-dialog");
  const opener=$("#settings-open");
  // A settings entry inside the workbench must return to that actual trigger,
  // not jump to the header and lose the user's adjustment context.
  let returnFocus=opener;
  const restoreFocus=()=>{
    const target=returnFocus?.isConnected?returnFocus:opener;
    target.focus({preventScroll:true});
  };
  const show=event=>{
    if(dialog.open)return;
    returnFocus=event?.currentTarget instanceof HTMLElement?event.currentTarget:opener;
    try{if(typeof dialog.showModal!=="function")throw Error("no dialog API");dialog.showModal();}
    catch{dialog.setAttribute("open","");dialog.setAttribute("role","dialog");}
  };
  const close=()=>{
    if(!dialog.open)return;
    try{if(typeof dialog.close==="function")dialog.close();else dialog.removeAttribute("open");}
    catch{dialog.removeAttribute("open");}
    restoreFocus();
  };
  const debug=$("#debug-mode");
  const debugKey="frequency-warp:debug-mode:v1";
  const initiallyRequested=new URL(location.href).searchParams.get("layout_editor")==="1";
  try{debug.checked=initiallyRequested||localStorage.getItem(debugKey)==="1";}
  catch{debug.checked=initiallyRequested;}
  const debugFeedback=$("#debug-mode-feedback");
  let debugRevision=0;
  debug.addEventListener("change",async()=>{
    const revision=++debugRevision;
    const enabled=debug.checked;
    debugFeedback.hidden=true;
    debugFeedback.textContent="";
    try{localStorage.setItem(debugKey,enabled?"1":"0");}catch{}
    if(!enabled){
      // Explicit settings switch takes precedence over a stale URL opt-in.
      const url=new URL(location.href);
      url.searchParams.delete("layout_editor");
      history.replaceState(history.state,"",url);
      window.dispatchEvent(new CustomEvent("fw:debug-change",{detail:{enabled:false}}));
      return;
    }
    try{
      await import("./visual-editor.mjs");
      // A late module must not re-enable an inspector after an OFF gesture.
      if(revision!==debugRevision||!debug.checked){
        window.dispatchEvent(new CustomEvent("fw:debug-change",{detail:{enabled:false}}));
        return;
      }
      window.dispatchEvent(new CustomEvent("fw:debug-change",{detail:{enabled:true}}));
    }catch(error){
      if(revision!==debugRevision||!debug.checked)return;
      debug.checked=false;
      try{localStorage.setItem(debugKey,"0");}catch{}
      debugFeedback.textContent="レイアウト編集を読み込めませんでした。接続を確認し、再度オンにしてください。";
      debugFeedback.hidden=false;
      console.warn("Frequency Warp debug editor could not load",error);
    }
  });
  for(const tip of document.querySelectorAll("details.info-tip,details.help-inline")){
    const close=()=>tip.open=false;
    tip.addEventListener("pointerenter",e=>{if(e.pointerType==="mouse")tip.open=true;});
    tip.addEventListener("pointerleave",e=>{if(e.pointerType==="mouse")close();});
    tip.addEventListener("focusout",e=>{if(!tip.contains(e.relatedTarget))close();});
    tip.addEventListener("keydown",e=>{if(e.key==="Escape"){close();e.stopPropagation();}});
  }
  document.addEventListener("pointerdown",e=>{
    for(const tip of document.querySelectorAll("details.info-tip[open],details.help-inline[open]"))
      if(!tip.contains(e.target))tip.open=false;
  },true);
  opener.addEventListener("click",show);
  $("#settings-inline").addEventListener("click",show);
  // Escape/native dialog.close() can bypass the explicit buttons.
  dialog.addEventListener("close",restoreFocus);
  $("#settings-close").addEventListener("click",close);
  $("#settings-done").addEventListener("click",close);
  dialog.addEventListener("click",event=>{if(event.target===dialog)close();});
  // Independent of the Web DSP module: the HUD remains usable on load errors.
  const hud=$("#runtime-hud"),hudHead=$("#runtime-hud-head");
  const collapse=$("#runtime-hud-collapse"),hide=$("#runtime-hud-hide");
  const restore=$("#runtime-hud-restore"),brief=$("#runtime-hud-brief");
  // A collapsed mobile badge must still disclose real warnings/failures.
  // Hiding the detailed HUD is not permission to hide a failed audio state.
  const status=$("#status");
  const updateBrief=()=>{
    const important=["error","warning"].includes(status.dataset.kind)
      ?status.textContent.trim():"";
    brief.textContent=(important||$("#rt-indicator")?.textContent||"停止中").slice(0,55);
  };
  const statusObserver=new MutationObserver(updateBrief);
  statusObserver.observe($("#rt-indicator"),{childList:true,subtree:true,characterData:true});
  statusObserver.observe(status,{childList:true,subtree:true,characterData:true,attributes:true,attributeFilter:["data-kind"]});
  updateBrief();
  // On narrow touch screens the full floating diagnostics can obscure the
  // right-hand square graph or linked frequency selector. Retain an explicit
  // restore affordance and full diagnostics on demand, without reflow.
  if(window.matchMedia("(max-width:600px)").matches){
    hud.classList.add("is-hidden");
    restore.hidden=false;
  }
  collapse.addEventListener("click",()=>{
    const folded=hud.classList.toggle("is-collapsed");
    collapse.textContent=folded?"+":"−";
    collapse.setAttribute("aria-expanded",String(!folded));
    collapse.setAttribute("aria-label",folded?"処理状態の詳細を開く":"処理状態の詳細を畳む");
  });
  hide.addEventListener("click",()=>{
    hud.classList.add("is-hidden");restore.hidden=false;updateBrief();
  });
  restore.addEventListener("click",()=>{
    hud.classList.remove("is-hidden");restore.hidden=true;
  });
  let drag=null;
  hudHead.addEventListener("pointerdown",event=>{
    if(event.button!==0||event.target.closest("button"))return;
    const box=hud.getBoundingClientRect();
    drag={id:event.pointerId,dx:event.clientX-box.left,dy:event.clientY-box.top};
    hudHead.setPointerCapture?.(event.pointerId);
    event.preventDefault();
  });
  hudHead.addEventListener("pointermove",event=>{
    if(!drag||drag.id!==event.pointerId)return;
    hud.style.right="auto";hud.style.bottom="auto";
    const width=hud.offsetWidth,height=hud.offsetHeight;
    hud.style.left=Math.max(0,Math.min(window.innerWidth-width,event.clientX-drag.dx))+"px";
    hud.style.top=Math.max(0,Math.min(window.innerHeight-height,event.clientY-drag.dy))+"px";
  });
  const endDrag=()=>{drag=null;};
  hudHead.addEventListener("pointerup",endDrag);
  hudHead.addEventListener("pointercancel",endDrag);
  window.addEventListener("resize",()=>{
    if(!hud.style.left)return;
    hud.style.left=Math.max(0,Math.min(innerWidth-hud.offsetWidth,parseFloat(hud.style.left)))+"px";
    hud.style.top=Math.max(0,Math.min(innerHeight-hud.offsetHeight,parseFloat(hud.style.top)))+"px";
  });
  // The source-to-export handoff is available without opening Settings or
  // requiring a layout rearrangement. A disabled render stays visibly disabled.
  $("#export-jump").addEventListener("click",()=>{
    const destination=$(".offline-tool"),render=$("#render");
    if(!destination)return;
    destination.open=true;
    destination.scrollIntoView({block:"center",behavior:"auto"});
    (render?.disabled?destination.querySelector("summary"):render)
      ?.focus({preventScroll:true});
  });
  // A missing top-level import prevents app.mjs from executing *any* handler.
  // Avoid a deceptively ready UI when this happens: settings stay usable and
  // native file chooser opens, while audio decoding reports the missing boot.
  setTimeout(()=>{
    if(document.documentElement.dataset.fwBoot!=="ready"){
      const status=$("#status");
      if(status){
        status.textContent="音声処理の起動に失敗しました。ページを再読込みしてください。";
        status.dataset.kind="error";
        // On phones the diagnostic HUD is collapsed; do not leave the
        // seemingly usable native file picker with no decoder attached.
        const meta=$("#file-meta");
        if(meta&&!meta.textContent.includes("読込失敗"))
          meta.textContent="音声処理を起動できませんでした。ページの再読込みが必要です。";
      }
    }
  },7000);
})();
