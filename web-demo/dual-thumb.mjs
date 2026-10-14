/**
 * One real track, two independently accessible and draggable thumbs.
 * The source ranges remain the single settings/AudioWorklet/WAV model.
 * Numeric precision, Rust audio processing and graph controls are NOT copied.
 * Accessible roles, Pointer Events and keyboard all dispatch native "input".
 */
export function mountDualThumb(root,sourceIds,formatters=[]){
  if(!root||sourceIds.length!==2)throw Error("dual-thumb configuration");
  const sources=sourceIds.map(id=>root.querySelector("#"+id));
  const thumbs=[...root.querySelectorAll("[data-dual-thumb]")];
  const inner=root.querySelector("[data-dual-inner]");
  if(!inner||sources.some(x=>!x)||thumbs.length!==2){
    throw Error("dual-thumb input and handle must have pairs");
  }
  const norm=(src)=>{
    const lo=Number(src.min),hi=Number(src.max);
    return hi>lo?Math.max(0,Math.min(1,(Number(src.value)-lo)/(hi-lo))):0;
  };
  const sync=()=>{
    sources.forEach((source,i)=>{
      const thumb=thumbs[i];
      const value=Number(source.value);
      thumb.style.left=(norm(source)*100)+"%";
      thumb.setAttribute("aria-valuemin",source.min);
      thumb.setAttribute("aria-valuemax",source.max);
      thumb.setAttribute("aria-valuenow",String(value));
      thumb.setAttribute("aria-valuetext",formatters[i]?.(value)||String(value));
    });
    // Distinct colors identify the two values; fill is a relationship cue
    // only. No imposed ordering (synthesis and reflection are independent).
    root.style.setProperty("--dual-first",(norm(sources[0])*100)+"%");
    root.style.setProperty("--dual-second",(norm(sources[1])*100)+"%");
  };
  const set=(i,value)=>{
    const source=sources[i],min=Number(source.min),max=Number(source.max);
    const step=Number(source.step)||1;
    const clamped=Math.max(min,Math.min(max,value));
    const rounded=Math.round((clamped-min)/step)*step+min;
    const next=String(Number(Math.max(min,Math.min(max,rounded)).toFixed(7)));
    if(source.value===next)return;
    source.value=next;
    // Keep every consumer on the existing single-source path.
    source.dispatchEvent(new Event("input",{bubbles:true}));
    sync();
  };
  let active=null,pointerId=null;
  const fromPointer=(event)=>{
    const rect=inner.getBoundingClientRect();
    return Math.max(0,Math.min(1,(event.clientX-rect.left)/Math.max(1,rect.width)));
  };
  const pick=(event)=>{
    const direct=event.target.closest?.("[data-dual-thumb]");
    if(direct&&root.contains(direct))return thumbs.indexOf(direct);
    const rect=inner.getBoundingClientRect(),fraction=fromPointer(event);
    const y=event.clientY-rect.top;
    // The two handles sit vertically separated above/below ONE track.
    // Distance to the actual thumb wins, including overlapping x values.
    const scores=sources.map((source,i)=>{
      const targetX=norm(source)*rect.width,targetY=i===0?11:rect.height-11;
      return Math.hypot((fraction*rect.width-targetX),(.85*(y-targetY)));
    });
    return scores[0]<=scores[1]?0:1;
  };
  const handlePointerDown=(event)=>{
    if(event.button!==undefined&&event.pointerType==="mouse"&&event.button!==0)return;
    if(active!==null)return;
    active=pick(event);pointerId=event.pointerId;
    // Synthetic PointerEvents used by automation have no active pointer to
    // capture; physical mouse/touch events do. Both must keep working.
    try{root.setPointerCapture?.(pointerId);}catch{}
    const source=sources[active],min=Number(source.min),max=Number(source.max);
    set(active,min+fromPointer(event)*(max-min));
    thumbs[active].focus({preventScroll:true});
    event.preventDefault();
  };
  const handlePointerMove=(event)=>{
    if(active===null||event.pointerId!==pointerId)return;
    const source=sources[active],min=Number(source.min),max=Number(source.max);
    set(active,min+fromPointer(event)*(max-min));
    event.preventDefault();
  };
  const endPointer=(event)=>{
    if(active===null||event.pointerId!==pointerId)return;
    active=null;pointerId=null;
    if(root.hasPointerCapture?.(event.pointerId))root.releasePointerCapture(event.pointerId);
  };
  root.addEventListener("pointerdown",handlePointerDown);
  root.addEventListener("pointermove",handlePointerMove);
  root.addEventListener("pointerup",endPointer);
  root.addEventListener("pointercancel",endPointer);
  root.addEventListener("lostpointercapture",()=>{
    active=null;pointerId=null;
  });
  thumbs.forEach((thumb,i)=>{
    thumb.addEventListener("keydown",event=>{
      const src=sources[i],min=Number(src.min),max=Number(src.max),step=Number(src.step)||1;
      let next=Number(src.value);
      if(event.key==="ArrowRight"||event.key==="ArrowUp")next+=step;
      else if(event.key==="ArrowLeft"||event.key==="ArrowDown")next-=step;
      else if(event.key==="PageUp")next+=10*step;
      else if(event.key==="PageDown")next-=10*step;
      else if(event.key==="Home")next=min;
      else if(event.key==="End")next=max;
      else return;
      event.preventDefault();
      set(i,next);
    });
  });
  sources.forEach(src=>src.addEventListener("input",sync));
  sync();
  return {sync,values:()=>sources.map(s=>Number(s.value))};
}
