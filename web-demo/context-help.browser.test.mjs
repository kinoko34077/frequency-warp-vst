/** #355 G2 browser contract: actual contextual help actions, not source-only geometry. */
import {test} from "node:test";
import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {resolve} from "node:path";
import puppeteer from "puppeteer-core";

const port=8846,site="http://127.0.0.1:"+port+"/index.html";
const sizes=[
  {width:320,height:568,mobile:true},
  {width:390,height:844,mobile:true},
  {width:768,height:844,mobile:true},
  {width:1365,height:900,mobile:false}
];
async function ready(){
  for(let n=0;n<60;n++){
    try{const r=await fetch(site);await r.arrayBuffer();if(r.ok)return;}
    catch{}
    await new Promise(done=>setTimeout(done,100));
  }
  throw Error("G2 staged Pages server unavailable");
}
async function shown(page,index){
  return await page.evaluate(index=>{
    const tip=document.querySelectorAll("details.info-tip")[index];
    const summary=tip.querySelector(":scope > summary");
    const body=tip.querySelector(":scope > .info-body");
    const rect=body.getBoundingClientRect();
    const bounds={width:document.documentElement.clientWidth,height:innerHeight};
    const center={x:rect.left+Math.min(rect.width/2,100),y:rect.top+Math.min(rect.height/2,60)};
    const hit=document.elementFromPoint(center.x,center.y);
    return {label:summary.getAttribute("aria-label"),open:tip.open,
      topLayer:body.matches(":popover-open"),role:body.getAttribute("role"),
      bodyId:body.id,describedBy:summary.getAttribute("aria-describedby"),
      x:rect.left,y:rect.top,right:rect.right,bottom:rect.bottom,
      w:rect.width,h:rect.height,bounds,
      pageWidth:document.documentElement.scrollWidth,
      hitContent:Boolean(hit&&(body===hit||body.contains(hit))),
      withinViewport:rect.left>=-1&&rect.top>=-1&&rect.right<=bounds.width+1&&rect.bottom<=bounds.height+1};
  },index);
}
test("#355 G2 context-help: every ⓘ escapes clipping and restores keyboard/scroll state",{
  timeout:180000
},async()=>{
  const server=spawn(process.env.PYTHON_BIN||"python3",
    ["-m","http.server",String(port),"--bind","127.0.0.1"],{
      cwd:resolve(process.env.WARP_WEB_ROOT||"_site"),stdio:"ignore"
    });
  let browser;
  try{
    await ready();
    browser=await puppeteer.launch({
      executablePath:process.env.CHROME_BIN||"/usr/bin/google-chrome",
      headless:true,args:["--no-sandbox","--disable-dev-shm-usage"]
    });
    for(const size of sizes){
      const page=await browser.newPage(),errors=[];
      page.on("pageerror",e=>errors.push(e.message));
      await page.setViewport({...size,deviceScaleFactor:1,hasTouch:size.mobile});
      await page.goto(site,{waitUntil:"domcontentloaded"});
      await page.waitForFunction(()=>document.documentElement.dataset.fwBoot==="ready",{timeout:20000});
      const count=await page.$$eval("details.info-tip",items=>items.length);
      assert.equal(count,9,"G0b static information-tip set must remain intact");
      for(let i=0;i<count;i++){
        await page.evaluate(i=>{
          const tip=document.querySelectorAll("details.info-tip")[i];
          tip.querySelector("summary").scrollIntoView({block:"center",inline:"nearest"});
          tip.querySelector("summary").focus({preventScroll:true});
        },i);
        await page.keyboard.press("Enter");
        await page.waitForFunction(i=>document.querySelectorAll("details.info-tip")[i].querySelector(".info-body").matches(":popover-open"),{},i);
        const record=await shown(page,i);
        console.log("G2_HELP "+JSON.stringify({viewport:size.width,index:i+1,...record}));
        assert.ok(record.open&&record.topLayer&&record.withinViewport&&record.hitContent,
          "context help must be fully visible, top-layer and hit-testable "+JSON.stringify(record));
        assert.equal(record.pageWidth<=size.width+1,true,
          "open help must not create horizontal document overflow "+JSON.stringify(record));
        assert.equal(record.role,"tooltip");
        assert.equal(record.bodyId,record.describedBy,"tooltip must be linked to its trigger");
        await page.keyboard.press("Escape");
        await page.waitForFunction(i=>!document.querySelectorAll("details.info-tip")[i].open,{},i);
        const hidden=await page.evaluate(i=>{
          const tip=document.querySelectorAll("details.info-tip")[i];
          return {open:tip.open,topLayer:tip.querySelector(".info-body").matches(":popover-open")};
        },i);
        assert.deepEqual(hidden,{open:false,topLayer:false},"Escape closes native help");
      }
      // Touch entry is separate from keyboard interaction.
      if(size.mobile){
        const tip="details.info-tip";
        await page.$eval(tip,el=>el.scrollIntoView({block:"center"}));
        const rect=await page.$eval(tip+" > summary",el=>{
          const r=el.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2};
        });
        await page.touchscreen.tap(rect.x,rect.y);
        await page.waitForFunction(()=>document.querySelector("details.info-tip")?.querySelector(".info-body").matches(":popover-open"));
        const touchRecord=await shown(page,0);
        assert.ok(touchRecord.withinViewport&&touchRecord.hitContent,"touch-open contextual help remains readable");
        await page.touchscreen.tap(Math.min(size.width-12,300),size.height-18);
        await page.waitForFunction(()=>!document.querySelector("details.info-tip").open);
      }
      // A non-Popover host must still see the original content through the
      // temporary same-node portal, and restore it without duplicate IDs.
      if(size.width===390){
        await page.evaluate(()=>{
          const body=document.querySelector("details.info-tip > .info-body");
          body.showPopover=undefined;
          body.hidePopover=undefined;
          document.querySelector("details.info-tip > summary").focus();
        });
        await page.keyboard.press("Enter");
        await page.waitForFunction(()=>Boolean(document.querySelector(".info-body.fw-help-portaled")),{timeout:5000});
        const fallback=await page.evaluate(()=>{
          const tip=document.querySelector("details.info-tip"),body=document.getElementById("fw-info-content-1");
          const r=body.getBoundingClientRect();
          const middle=document.elementFromPoint(r.left+r.width/2,r.top+Math.min(r.height/2,35));
          return {moved:body.parentElement===document.body,open:tip.open,
            visible:getComputedStyle(body).display!=="none"&&r.height>0,
            hit:Boolean(middle&&(middle===body||body.contains(middle))),
            inside:r.left>=-1&&r.right<=document.documentElement.clientWidth+1,
            dup:document.querySelectorAll("#fw-info-content-1").length};
        });
        assert.deepEqual(fallback,{moved:true,open:true,visible:true,hit:true,inside:true,dup:1},
          "fallback portal must keep the one actual help body visible");
        await page.keyboard.press("Escape");
        const restored=await page.evaluate(()=>{
          const tip=document.querySelector("details.info-tip");
          const body=document.getElementById("fw-info-content-1");
          return !tip.open&&tip.contains(body)&&!body.classList.contains("fw-help-portaled");
        });
        assert.equal(restored,true,"fallback must restore original DOM ownership");
      }
      assert.deepEqual(errors,[],"opening and closing help must not throw page errors");
      await page.close();
    }
  }finally{await browser?.close();server.kill();}
});
