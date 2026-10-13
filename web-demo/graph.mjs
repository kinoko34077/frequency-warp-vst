import {DISPLAY_MIN,DISPLAY_MAX,graphSegments} from "./harmonics.mjs";
// Geometry only. Live mapping is supplied by the SAME compiled Rust/WASM
// function warp_map_frequency used by native streaming DSP.

/** Equal-scale 20..2000 Hz full-field plot; no DSP performed in JavaScript. */
export function drawFrequencyGraph(canvas,settings,warp,translate) {
  const ratio=Math.min(globalThis.devicePixelRatio||1,2);
  const size=Math.max(250,Math.round(canvas.getBoundingClientRect().width*ratio));
  canvas.width=size;canvas.height=size;
  const ctx=canvas.getContext("2d");
  // Plot *inside* the canvas is square, not just the outer canvas.
  // Thus 100 Hz has equal physical extent on both x and y axes.
  const side=size-52*ratio,left=38*ratio,top=12*ratio;
  const right=left+side,bottom=top+side;
  const width=side,height=side;
  const x=f=>left+(f-DISPLAY_MIN)/(DISPLAY_MAX-DISPLAY_MIN)*width;
  const y=f=>bottom-(f-DISPLAY_MIN)/(DISPLAY_MAX-DISPLAY_MIN)*height;
  ctx.clearRect(0,0,size,size);
  ctx.fillStyle="#081a1f";ctx.fillRect(left,top,width,height);
  {
    const lo=Math.max(DISPLAY_MIN,settings.low),hi=Math.min(DISPLAY_MAX,settings.high);
    if(hi>lo){ctx.fillStyle="rgba(60,212,168,.12)";ctx.fillRect(x(lo),top,x(hi)-x(lo),height);}
  }
  ctx.font=(10*ratio)+"px system-ui";ctx.textAlign="center";ctx.textBaseline="top";
  ctx.strokeStyle="#244149";ctx.lineWidth=ratio;
  for(const value of [20,500,1000,1500,2000]){
    const xx=x(value),yy=y(value);
    ctx.beginPath();ctx.moveTo(xx,top);ctx.lineTo(xx,bottom);
    ctx.moveTo(left,yy);ctx.lineTo(right,yy);ctx.stroke();
    ctx.fillStyle="#9cb7bb";
    ctx.fillText(value===2000?"2k":String(value),xx,bottom+5*ratio);
    ctx.textAlign="right";ctx.textBaseline="middle";
    ctx.fillText(value===2000?"2k":String(value),left-5*ratio,yy);
    ctx.textAlign="center";ctx.textBaseline="top";
  }
  ctx.setLineDash([4*ratio,5*ratio]);ctx.strokeStyle="#70878b";
  ctx.beginPath();ctx.moveTo(left,bottom);ctx.lineTo(right,top);ctx.stroke();ctx.setLineDash([]);
  {
    for(const [hz,label] of [[settings.low,"L"],[settings.high,"H"]]){
      if(hz<DISPLAY_MIN||hz>DISPLAY_MAX)continue;
      const xx=x(hz);ctx.setLineDash([3*ratio,3*ratio]);ctx.strokeStyle="#e1b67b";
      ctx.beginPath();ctx.moveTo(xx,top);ctx.lineTo(xx,bottom);ctx.stroke();ctx.setLineDash([]);
      ctx.fillStyle="#e1b67b";ctx.fillText(label,xx,top+4*ratio);
    }
  }
  const rows=graphSegments(settings,warp,translate);
  for(let channel=0;channel<(settings.ringEnabled?2:1);channel++){
    ctx.lineWidth=2.4*ratio;ctx.strokeStyle=channel===0?"#66e9ba":"#f0b97b";
    ctx.beginPath();let active=false,lastInside=false,lastY=0;
    for(const point of rows){
      const f=point.outputs[channel];
      if(f===undefined){if(active)ctx.stroke();ctx.beginPath();active=false;continue;}
      const xx=x(point.f),yy=y(f);
      if(!active || lastInside!==point.inside || Math.abs(yy-lastY)>height*.32){
        if(active)ctx.stroke();ctx.beginPath();ctx.moveTo(xx,yy);
      }else ctx.lineTo(xx,yy);
      active=true;lastInside=point.inside;lastY=yy;
    }
    if(active)ctx.stroke();
  }
  ctx.fillStyle="#b4c6c5";ctx.font=(11*ratio)+"px system-ui";
  ctx.textAlign="center";ctx.textBaseline="alphabetic";
  ctx.fillText("Input f (Hz)",(left+right)/2,size-3*ratio);
  ctx.save();ctx.translate(11*ratio,(top+bottom)/2);ctx.rotate(-Math.PI/2);
  ctx.fillText("Output f′ (Hz)",0,0);ctx.restore();
}
