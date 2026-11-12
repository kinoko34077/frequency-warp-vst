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
  // The Settings modal must not leave a contextual tooltip above an unrelated task.
  let dismissInfoTips=()=>{};
  const restoreFocus=()=>{
    const target=returnFocus?.isConnected?returnFocus:opener;
    target.focus({preventScroll:true});
  };
  const show=event=>{
    if(dialog.open)return;
    dismissInfoTips();
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
  if(debug.checked){
    $("#prototype-info").open=true;
    $("#developer-tools").open=true;
  }
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
  // #355: one contextual-help lifecycle. Keep the original text nodes in their
  // existing details (and all their IDs/data listeners). A native manual Popover
  // puts the body in the top layer without copying text or being clipped by
  // .workspace-right overflow. On older browsers, move that same node to body
  // temporarily; neither mode creates a second explanation or a parallel store.
  const tips=[...document.querySelectorAll("details.info-tip")];
  const helpStates=new Map();
  const activeTips=new Set();
  const viewportBounds=()=>{
    const v=window.visualViewport;
    const left=v?.offsetLeft??0,top=v?.offsetTop??0;
    return {left,top,right:left+(v?.width??document.documentElement.clientWidth),
      bottom:top+(v?.height??window.innerHeight)};
  };
  const positionInfo=(tip)=>{
    const state=helpStates.get(tip),body=state?.body;
    if(!body||!tip.open||!body.isConnected)return;
    const b=viewportBounds(),margin=8,anchor=state.summary.getBoundingClientRect();
    body.style.maxWidth=Math.max(90,b.right-b.left-margin*2)+"px";
    body.style.maxHeight=Math.max(70,Math.min(330,b.bottom-b.top-margin*2))+"px";
    const width=body.offsetWidth,height=body.offsetHeight;
    const left=Math.min(Math.max(anchor.left,b.left+margin),b.right-width-margin);
    const below=anchor.bottom+5,above=anchor.top-height-5;
    const top=below+height<=b.bottom-margin?below:
      above>=b.top+margin?above:
      Math.max(b.top+margin,Math.min(below,b.bottom-height-margin));
    body.style.left=left+"px";body.style.top=top+"px";
  };
  const restoreBody=state=>{
    if(!state.portaled)return;
    state.marker.replaceWith(state.body);
    state.portaled=false;
    state.body.classList.remove("fw-help-portaled");
  };
  const closeInfo=tip=>{
    const state=helpStates.get(tip);
    if(!state)return;
    if(tip.open)tip.open=false;
    if(typeof state.body.hidePopover==="function"&&state.body.matches(":popover-open"))
      state.body.hidePopover();
    restoreBody(state);
    state.summary.removeAttribute("aria-describedby");
    activeTips.delete(tip);
  };
  const openInfo=tip=>{
    const state=helpStates.get(tip);if(!state||!tip.open)return;
    for(const other of [...activeTips])if(other!==tip)closeInfo(other);
    const body=state.body;
    const showing=typeof body.showPopover==="function"&&body.matches(":popover-open");
    if(!state.portaled&&!showing){
      if(typeof body.showPopover==="function"){
        try{body.showPopover();}
        catch{
          // A legacy/embedded host might advertise the API but reject top layer.
          state.marker=document.createComment("fw-help-original-position");
          body.before(state.marker);document.body.append(body);
          state.portaled=true;body.classList.add("fw-help-portaled");
        }
      }else{
        state.marker=document.createComment("fw-help-original-position");
        body.before(state.marker);document.body.append(body);
        state.portaled=true;body.classList.add("fw-help-portaled");
      }
    }
    activeTips.add(tip);
    state.summary.setAttribute("aria-describedby",body.id);
    positionInfo(tip);
  };
  for(const [i,tip] of tips.entries()){
    const summary=tip.querySelector(":scope > summary"),body=tip.querySelector(":scope > .info-body");
    if(!summary||!body)continue;
    if(!body.id)body.id="fw-info-content-"+(i+1);
    body.setAttribute("role","tooltip");
    // Manual: Escape/outside click are owned by this single controller.
    // 'auto' would fight the existing Settings, snap and digit controls.
    if(typeof body.showPopover==="function")body.setAttribute("popover","manual");
    helpStates.set(tip,{summary,body,marker:null,portaled:false});
    tip.addEventListener("toggle",()=>tip.open?openInfo(tip):closeInfo(tip));
    tip.addEventListener("pointerenter",e=>{if(e.pointerType==="mouse")tip.open=true;});
    tip.addEventListener("pointerleave",e=>{
      if(e.pointerType==="mouse"&&!body.contains(e.relatedTarget))closeInfo(tip);
    });
    tip.addEventListener("focusout",e=>{
      if(!tip.contains(e.relatedTarget)&&!body.contains(e.relatedTarget))closeInfo(tip);
    });
    body.addEventListener("pointerleave",e=>{
      if(e.pointerType==="mouse"&&!tip.contains(e.relatedTarget))closeInfo(tip);
    });
  }
  dismissInfoTips=()=>{for(const tip of [...activeTips])closeInfo(tip);};
  // Keep long explanations in Settings and the math lab as inline disclosures;
  // their semantics and scrolling requirements differ from short floating ⓘ.
  for(const tip of document.querySelectorAll("details.help-inline")){
    const close=()=>tip.open=false;
    tip.addEventListener("pointerenter",e=>{if(e.pointerType==="mouse")tip.open=true;});
    tip.addEventListener("pointerleave",e=>{if(e.pointerType==="mouse")close();});
    tip.addEventListener("focusout",e=>{if(!tip.contains(e.relatedTarget))close();});
  }
  document.addEventListener("pointerdown",e=>{
    for(const tip of [...activeTips]){
      const body=helpStates.get(tip)?.body;
      if(!tip.contains(e.target)&&!body?.contains(e.target))closeInfo(tip);
    }
    for(const tip of document.querySelectorAll("details.help-inline[open]"))
      if(!tip.contains(e.target))tip.open=false;
  },true);
  document.addEventListener("keydown",e=>{
    if(e.key!=="Escape")return;
    if(activeTips.size){dismissInfoTips();e.stopPropagation();e.preventDefault();}
    else for(const tip of document.querySelectorAll("details.help-inline[open]"))tip.open=false;
  },true);
  let helpLayoutFrame=0;
  const scheduleHelpPosition=()=>{
    if(!activeTips.size||helpLayoutFrame)return;
    helpLayoutFrame=requestAnimationFrame(()=>{
      helpLayoutFrame=0;
      for(const tip of [...activeTips]){
        if(tip.isConnected&&tip.open)positionInfo(tip);else closeInfo(tip);
      }
    });
  };
  window.addEventListener("resize",scheduleHelpPosition,{passive:true});
  document.addEventListener("scroll",scheduleHelpPosition,true);
  window.visualViewport?.addEventListener("resize",scheduleHelpPosition,{passive:true});
  window.visualViewport?.addEventListener("scroll",scheduleHelpPosition,{passive:true});
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
  const sourceRegion=$("#source-region"),sourceSummary=sourceRegion?.querySelector(":scope > summary"),stop=$("#stop");
  // A collapsed mobile badge must still disclose real warnings/failures.
  // Hiding the detailed HUD is not permission to hide a failed audio state.
  const status=$("#status");
  const updateBrief=()=>{
    const important=["error","warning"].includes(status.dataset.kind)
      ?status.textContent.trim():"";
    if(status.dataset.kind==="error"&&sourceRegion&&!sourceRegion.open)sourceRegion.open=true;
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
  // The Stop control lives in the source region. Keep that region open while
  // audio is active so folding it cannot hide the only playback recovery.
  sourceSummary?.addEventListener("click",event=>{
    if(!sourceRegion.open||stop.disabled)return;
    event.preventDefault();
    status.dataset.kind="warning";
    status.textContent="再生中は停止してから音源欄を閉じてください。";
    updateBrief();
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
    hud.classList.add("is-floating");
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
