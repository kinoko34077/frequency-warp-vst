/** Small entry controls do not depend on the large audio/WASM module graph.
 * Settings and the native <input type=file> must remain discoverable even if
 * a DSP module or deployment resource fails to load.
 */
(()=>{
  const $=id=>document.querySelector(id);
  const dialog=$("#settings-dialog");
  const opener=$("#settings-open");
  const show=()=>{
    if(dialog.open)return;
    try{if(typeof dialog.showModal!=="function")throw Error("no dialog API");dialog.showModal();}
    catch{dialog.setAttribute("open","");dialog.setAttribute("role","dialog");}
  };
  const close=()=>{
    if(!dialog.open)return;
    try{if(typeof dialog.close==="function")dialog.close();else dialog.removeAttribute("open");}
    catch{dialog.removeAttribute("open");}
    opener.focus();
  };
  const debug=$("#debug-mode");
  const debugKey="frequency-warp:debug-mode:v1";
  const initiallyRequested=new URL(location.href).searchParams.get("layout_editor")==="1";
  try{debug.checked=initiallyRequested||localStorage.getItem(debugKey)==="1";}
  catch{debug.checked=initiallyRequested;}
  debug.addEventListener("change",async()=>{
    const enabled=debug.checked;
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
      window.dispatchEvent(new CustomEvent("fw:debug-change",{detail:{enabled:true}}));
    }catch(error){
      debug.checked=false;
      try{localStorage.setItem(debugKey,"0");}catch{}
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
  $("#settings-close").addEventListener("click",close);
  $("#settings-done").addEventListener("click",close);
  dialog.addEventListener("click",event=>{if(event.target===dialog)close();});
  // A missing top-level import prevents app.mjs from executing *any* handler.
  // Avoid a deceptively ready UI when this happens: settings stay usable and
  // native file chooser opens, while audio decoding reports the missing boot.
  setTimeout(()=>{
    if(document.documentElement.dataset.fwBoot!=="ready"){
      const status=$("#status");
      if(status){
        status.textContent="音声処理の起動に失敗しました。ページを再読込みしてください。";
        status.dataset.kind="error";
      }
    }
  },7000);
})();
