/** Shared accessible dual-thumb rail controller.
 *
 * Both controls represent two independently editable values on ONE physical
 * horizontal scale. Their vertically-offset upper/lower thumbs remain
 * separately focusable native range inputs (keyboard/AT access).
 * Pointer/touch gestures are owned by the rail with pointer capture:
 * iOS Safari must not depend on overlapping native range hit targets.
 * Dragging always follows the thumb chosen on pointerdown, even when
 * the two values cross. A bare-track tap chooses the nearest 2D thumb.
 * Consumer input/change listeners remain authoritative for DSP updates.
 */
export function installDualThumb(rail,upper,lower,{offset=10,inset=10}={}){
  if(!rail||!upper||!lower)throw Error("Dual-thumb DOM controls not found");
  let active=null;
  const normal=(node)=>{
    const min=Number(node.min)||0,max=Number(node.max)||100;
    return max>min?(Number(node.value)-min)/(max-min):0;
  };
  const currentPosition=(event)=>{
    const rect=rail.getBoundingClientRect();
    const usable=Math.max(1,rect.width-2*inset);
    return {rect,x:Math.max(0,Math.min(1,
      (event.clientX-rect.left-inset)/usable))};
  };
  const draw=()=>{
    const one=normal(upper),two=normal(lower);
    rail.style.setProperty("--lo",(100*Math.min(one,two))+"%");
    rail.style.setProperty("--hi",(100*Math.max(one,two))+"%");
    rail.dataset.upper=String(Number(upper.value));
    rail.dataset.lower=String(Number(lower.value));
  };
  const nearest=(event,x,rect)=>{
    const centre=rect.top+rect.height/2;
    const usable=Math.max(1,rect.width-2*inset);
    const distance=(slider,y)=>{
      const dx=usable*(x-normal(slider));
      const dy=event.clientY-y;
      return dx*dx+dy*dy;
    };
    return distance(upper,centre-offset)<=distance(lower,centre+offset)?upper:lower;
  };
  const apply=(slider,x)=>{
    const min=Number(slider.min)||0,max=Number(slider.max)||100;
    const step=Number(slider.step)||1;
    // Keep the underlying native range step contract for keyboard parity.
    const raw=min+x*(max-min);
    const snapped=Math.max(min,Math.min(max,
      min+Math.round((raw-min)/step)*step));
    if(Number(slider.value)===snapped)return;
    slider.value=String(snapped);
    slider.dispatchEvent(new Event("input",{bubbles:true}));
    draw();
  };
  rail.addEventListener("pointerdown",event=>{
    if(active!==null || event.button>0)return;
    const {rect,x}=currentPosition(event);
    const slider=nearest(event,x,rect);
    active={pointerId:event.pointerId,slider};
    event.preventDefault();
    slider.focus({preventScroll:true});
    try{rail.setPointerCapture(event.pointerId);}catch{}
    apply(slider,x);
  });
  rail.addEventListener("pointermove",event=>{
    if(active===null||event.pointerId!==active.pointerId)return;
    event.preventDefault();
    apply(active.slider,currentPosition(event).x);
  });
  const end=event=>{
    if(!active||event.pointerId!==active.pointerId)return;
    const slider=active.slider;active=null;
    if(event.type==="pointerup"){
      apply(slider,currentPosition(event).x);
      slider.dispatchEvent(new Event("change",{bubbles:true}));
    }
    try{if(rail.hasPointerCapture(event.pointerId))
      rail.releasePointerCapture(event.pointerId);}catch{}
    draw();
  };
  rail.addEventListener("pointerup",end);
  rail.addEventListener("pointercancel",end);
  rail.addEventListener("lostpointercapture",end);
  for(const slider of [upper,lower]){
    slider.addEventListener("input",draw);
    slider.addEventListener("change",draw);
  }
  draw();
  return {draw};
}
