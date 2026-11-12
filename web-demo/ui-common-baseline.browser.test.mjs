/**
 * #355 G0b: observational UI baseline on the exact staged Pages entry.
 * This test records computed DOM/interaction evidence; it does not assert that
 * current presentation is correct or silently turn its baseline into a spec.
 * Device emulation is not physical iPhone/iOS evidence.
 */
import {test} from "node:test";
import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {readFile,writeFile,mkdir} from "node:fs/promises";
import {resolve} from "node:path";
import puppeteer from "puppeteer-core";

const viewports=[
  {width:320,height:568,mobile:true},
  {width:390,height:844,mobile:true},
  {width:768,height:844,mobile:true},
  {width:1365,height:900,mobile:false}
];
const port=8825;
const site="http://127.0.0.1:"+port+"/index.html";

function staticControlIds(source){
  return [...source.matchAll(/<(?:input|select|button)\b[^>]*?\bid=(["'])([^"']+)\1[^>]*>/gs)]
    .map(match=>match[2]);
}
async function waitForServer(){
  for(let attempt=0;attempt<60;attempt++){
    try{
      const response=await fetch(site);
      await response.arrayBuffer();
      if(response.ok)return;
    }catch{}
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  throw Error("G0b staged Pages server unavailable");
}

async function measure(page,expectedIds,modal){
  return await page.evaluate(({ids,modal})=>{
    const rbox=el=>{
      if(!el)return null;
      const r=el.getBoundingClientRect();
      return {x:r.x,y:r.y,left:r.left,right:r.right,top:r.top,bottom:r.bottom,
        width:r.width,height:r.height};
    };
    const region=el=>el.closest("#settings-dialog")?"settings":
      el.closest("#virtual-root-workbench")?"virtual-root":
      el.closest(".quick-panel")?"transform":
      el.closest(".workspace-right-column")?"graph":
      el.closest(".sine-monitor")?"auxiliary":
      el.closest("#source-region")?"source":"other";
    const styleOf=el=>{
      if(!el)return null;
      const c=getComputedStyle(el);
      return {display:c.display,visibility:c.visibility,opacity:c.opacity,
        background:c.backgroundColor,color:c.color,border:c.borderTopColor,
        borderWidth:c.borderTopWidth,borderRadius:c.borderRadius,
        padding:c.padding,fontSize:c.fontSize,lineHeight:c.lineHeight,
        minHeight:c.minHeight,outline:c.outlineColor,focus:c.outlineStyle,
        touchAction:c.touchAction,pointerEvents:c.pointerEvents,
        overflowX:c.overflowX,overflowY:c.overflowY,zIndex:c.zIndex};
    };
    const controls=ids.map(id=>{
      const el=document.getElementById(id);
      const r=rbox(el),s=styleOf(el);
      return {id,found:Boolean(el),region:el?region(el):null,
        type:el?.type||el?.tagName?.toLowerCase(),className:el?.className||"",
        ariaLabel:el?.getAttribute("aria-label")||null,
        disabled:Boolean(el?.disabled),readOnly:Boolean(el?.readOnly),
        visible:Boolean(r&&r.width>0&&r.height>0&&s.display!=="none"&&s.visibility!=="hidden"),
        rect:r,css:s};
    });
    const dynamic=[...document.querySelectorAll(
      '#virtual-root-workbench input[id],#virtual-root-workbench select[id],#virtual-root-workbench button[id]')]
      .filter(el=>!ids.includes(el.id)).map(el=>({
        id:el.id,tag:el.tagName,type:el.type,region:region(el),
        rect:rbox(el),css:styleOf(el)}));
    const allHelp=[...document.querySelectorAll("details.info-tip,details.help-inline")];
    const rows=[];
    const dlg=document.getElementById("settings-dialog");
    for(let i=0;i<allHelp.length;i++){
      const help=allHelp[i];
      const inDialog=dlg.contains(help);
      if(inDialog!==modal)continue;
      const summary=help.querySelector(":scope > summary");
      const record={index:i+1,kind:help.classList.contains("info-tip")?"tip":"inline",
        label:summary?.getAttribute("aria-label")||summary?.textContent?.trim()?.slice(0,75)||"",
        region:region(help),inDialog};
      const opened=[];
      for(let parent=help.parentElement;parent;parent=parent.parentElement){
        if(parent.tagName==="DETAILS"&&!parent.open){parent.open=true;opened.push(parent);}
      }
      const hidden=help.closest("[hidden]");
      if(hidden){
        record.status="hidden-by-branch";
        record.hiddenAncestor=hidden.id||hidden.className||hidden.tagName;
      }else{
        help.scrollIntoView({block:"center",inline:"nearest"});
        const wasOpen=help.open;
        help.open=true;
        const content=help.querySelector(":scope > .info-body")||
          help.querySelector(":scope > p")||help.querySelector(":scope > div");
        const summaryRect=rbox(summary),contentRect=rbox(content);
        const available={left:0,top:0,right:innerWidth,bottom:innerHeight};
        const clipped=[];
        for(let parent=help.parentElement;parent;parent=parent.parentElement){
          const s=getComputedStyle(parent);
          if(!/(auto|scroll|hidden|clip)/.test(s.overflowX+" "+s.overflowY))continue;
          const b=parent.getBoundingClientRect();
          if(contentRect && (contentRect.left<b.left-1||contentRect.right>b.right+1||
              contentRect.top<b.top-1||contentRect.bottom>b.bottom+1)){
            clipped.push({ancestor:parent.id||parent.className||parent.tagName,
              overflow:s.overflowX+"/"+s.overflowY,rect:rbox(parent)});
          }
        }
        const outside=contentRect?{
          left:Math.max(0,available.left-contentRect.left),
          top:Math.max(0,available.top-contentRect.top),
          right:Math.max(0,contentRect.right-available.right),
          bottom:Math.max(0,contentRect.bottom-available.bottom)
        }:null;
        const center=contentRect?{x:(contentRect.left+contentRect.right)/2,
          y:(contentRect.top+Math.min(contentRect.bottom,innerHeight))/2}:null;
        const hit=center&&center.x>=0&&center.x<=innerWidth&&center.y>=0&&center.y<=innerHeight
          ?document.elementFromPoint(center.x,center.y):null;
        Object.assign(record,{status:contentRect?.height>0?"measured":"empty",
          summary:summaryRect,content:contentRect,overflow:outside,
          clippedAncestors:clipped,centerHitOwnContent:Boolean(hit&&content?.contains(hit)),
          zIndex:styleOf(help)?.zIndex});
        help.open=wasOpen;
      }
      for(const el of opened.reverse())el.open=false;
      rows.push(record);
    }
    const group=(selector)=>[...document.querySelectorAll(selector)].map(el=>({
      id:el.id||el.getAttribute("aria-label")||null,
      rect:rbox(el),css:styleOf(el),region:region(el)}));
    return {modal,viewport:{width:innerWidth,height:innerHeight},
      staticControls:controls,staticFound:controls.filter(c=>c.found).length,
      dynamicControls:dynamic,help:rows,
      inlineValues:group("input.inline-value"),
      virtualNumbers:group(".vr-number-row input"),
      regularRails:group('input[type="range"]:not(.dual-source)'),
      dualRails:group(".shared-dual-track"),
      unitSwitches:group(".unit-switch"),
      pageOverflow:Math.max(0,document.documentElement.scrollWidth-innerWidth)};
  },{ids:expectedIds,modal});
}

function summary(record){
  const styles=new Map();
  for(const value of record.inlineValues){
    const c=value.css||{};
    const key=[c.fontSize,c.background,c.borderWidth,c.borderRadius,c.padding].join("|");
    styles.set(key,(styles.get(key)||0)+1);
  }
  const help=record.help.filter(h=>h.status==="measured");
  return {modal:record.modal,viewport:record.viewport,staticFound:record.staticFound,
    staticTotal:record.staticControls.length,dynamic:record.dynamicControls.length,
    help:record.help.length,measured:help.length,hidden:record.help.length-help.length,
    helpOutside:help.filter(h=>h.overflow&&Object.values(h.overflow).some(v=>v>1))
      .map(h=>({index:h.index,label:h.label,overflow:h.overflow})),
    helpClipped:help.filter(h=>h.clippedAncestors?.length)
      .map(h=>({index:h.index,label:h.label,ancestors:h.clippedAncestors.map(x=>x.ancestor)})),
    inlineStyleVariants:styles.size,inlineVariantCounts:[...styles.values()].sort((a,b)=>b-a),
    pageOverflow:record.pageOverflow};
}

test("#355 G0b baseline: static/dynamic controls and all help surfaces",{
  timeout:180000
},async()=>{
  const html=await readFile(resolve("web-demo/index.html"),"utf8");
  const ids=staticControlIds(html);
  assert.equal(ids.length,105,"G0a static control inventory count must match the actual source");
  assert.equal(new Set(ids).size,ids.length,"G0a static controls must have unique IDs");
  const server=spawn(process.env.PYTHON_BIN||"python3",
    ["-m","http.server",String(port),"--bind","127.0.0.1"],{
      cwd:resolve(process.env.WARP_WEB_ROOT||"_site"),stdio:"ignore"
    });
  let browser;
  const records=[],issues=[];
  try{
    await waitForServer();
    browser=await puppeteer.launch({
      executablePath:process.env.CHROME_BIN||"/usr/bin/google-chrome",
      headless:true,args:["--no-sandbox","--disable-dev-shm-usage"]
    });
    for(const viewport of viewports){
      const page=await browser.newPage();
      page.on("pageerror",e=>issues.push({viewport,message:e.message}));
      await page.setViewport({width:viewport.width,height:viewport.height,
        deviceScaleFactor:1,isMobile:viewport.mobile,hasTouch:viewport.mobile});
      await page.goto(site,{waitUntil:"domcontentloaded"});
      await page.waitForFunction(()=>document.documentElement.dataset.fwBoot==="ready",{timeout:20000});
      const ordinary=await measure(page,ids,false);
      assert.equal(ordinary.staticFound,ids.length,"DOM must preserve every static ID");
      records.push({mode:"normal",...ordinary});
      console.log("G0B_SUMMARY "+JSON.stringify({mode:"normal",...summary(ordinary)}));
      await page.click("#settings-open");
      const modal=await measure(page,ids,true);
      records.push({mode:"settings",...modal});
      console.log("G0B_SUMMARY "+JSON.stringify({mode:"settings",...summary(modal)}));
      const dialogOpen=await page.$eval("#settings-dialog",el=>el.open);
      assert.equal(dialogOpen,true,"settings dialog must open as a real dialog");
      await page.click("#settings-close");
      const back=await page.evaluate(()=>document.activeElement?.id);
      assert.equal(back,"settings-open","settings must restore trigger focus");
      await page.close();
    }
    const allHelp=records.filter(x=>x.mode==="normal"&&x.viewport.width===390)
      .flatMap(x=>x.help).concat(records.filter(x=>x.mode==="settings"&&x.viewport.width===390)
      .flatMap(x=>x.help));
    assert.equal(allHelp.length,17,"all static contextual help disclosures must be inventoried");
    assert.ok(records.find(x=>x.mode==="normal"&&x.dynamicControls.some(c=>c.id==="vr-source-f")),
      "dynamic virtual-root inputs must be included");
    const report={head:process.env.GITHUB_SHA||"unspecified-test-sha",
      baseline:"observational-not-acceptance",viewports,issues,records};
    await mkdir(resolve("g0b-reports"),{recursive:true});
    await writeFile(resolve("g0b-reports/ui-baseline.json"),JSON.stringify(report,null,2));
    console.log("G0B_DATASET "+JSON.stringify({records:records.length,
      staticIdCount:ids.length,helpCount:allHelp.length,issues:issues.length}));
    assert.deepEqual(issues,[],"page must not generate uncaught errors during measurement");
  }finally{
    await browser?.close();
    server.kill();
  }
});
