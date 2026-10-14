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
  opener.addEventListener("click",show);
  $("#settings-inline").addEventListener("click",show);
  $("#settings-close").addEventListener("click",close);
  $("#settings-done").addEventListener("click",close);
  dialog.addEventListener("click",event=>{if(event.target===dialog)close();});
  // Contextual explanations: native <details> is tap/keyboard accessible.
  // Position the disclosure within the visible viewport, not in document flow.
  const helpNodes=[...document.querySelectorAll("details.context-help")];
  const placeHelp=details=>{
    if(!details.open)return;
    const trigger=details.querySelector("summary");
    const panel=details.querySelector(".help-body");
    if(!trigger||!panel)return;
    const rect=trigger.getBoundingClientRect();
    const width=Math.min(320,window.innerWidth-24);
    const left=Math.min(Math.max(12,rect.left),Math.max(12,window.innerWidth-width-12));
    panel.style.width=width+"px";
    panel.style.left=left+"px";
    const panelHeight=panel.getBoundingClientRect().height;
    const below=window.innerHeight-rect.bottom-12;
    const above=rect.top-12;
    const top=below>=Math.min(panelHeight,180)||below>=above?
      rect.bottom+5:Math.max(10,rect.top-panelHeight-5);
    panel.style.top=Math.min(top,Math.max(10,window.innerHeight-panelHeight-10))+"px";
  };
  const closeOthers=except=>helpNodes.forEach(d=>{if(d!==except)d.open=false;});
  for(const details of helpNodes){
    details.addEventListener("toggle",()=>{
      if(details.open){closeOthers(details);placeHelp(details);}
    });
    details.addEventListener("mouseenter",()=>{
      if(window.matchMedia("(hover:hover)").matches){closeOthers(details);details.open=true;placeHelp(details);}
    });
    details.addEventListener("mouseleave",()=>{
      if(window.matchMedia("(hover:hover)").matches)details.open=false;
    });
  }
  document.addEventListener("pointerdown",event=>{
    if(!event.target.closest("details.context-help"))closeOthers(null);
  });
  document.addEventListener("keydown",event=>{
    if(event.key==="Escape")closeOthers(null);
  });
  window.addEventListener("resize",()=>helpNodes.forEach(placeHelp));

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
