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
