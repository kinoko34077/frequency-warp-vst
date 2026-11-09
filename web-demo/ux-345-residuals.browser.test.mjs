/** Focused browser acceptance for the residual layout defects reopened in #345. */
import {test} from "node:test";
import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {resolve} from "node:path";
import puppeteer from "puppeteer-core";

test("#345 residual UI: auxiliary tone, status, export, harmonic toggle, and shared dual thumbs",{
  timeout:45000
},async()=>{
  const port=Number(process.env.WARP_TEST_PORT||8797);
  const server=spawn(process.env.PYTHON_BIN||(process.platform==="win32"?"python":"python3"),
    ["-m","http.server",String(port),"--bind","127.0.0.1"],{
      cwd:resolve(process.env.WARP_WEB_ROOT||"_site"),stdio:"ignore"
    });
  let browser;
  try{
    for(let attempt=0;attempt<50;attempt++){
      try{
        const response=await fetch(`http://127.0.0.1:${port}/index.html`);
        await response.arrayBuffer();
        if(response.ok)break;
      }
      catch{}
      if(attempt===49)throw Error("staged Pages server did not start");
      await new Promise(resolve=>setTimeout(resolve,100));
    }
    browser=await puppeteer.launch({
      executablePath:process.env.CHROME_BIN||(process.platform==="win32"
        ?"C:/Program Files/Google/Chrome/Application/chrome.exe":"/usr/bin/google-chrome"),
      headless:true,args:["--no-sandbox","--disable-dev-shm-usage"]
    });
    const page=await browser.newPage(),errors=[];
    page.on("pageerror",error=>errors.push(error.message));
    await page.setViewport({width:390,height:844,deviceScaleFactor:1,isMobile:true,hasTouch:true});
    await page.goto(`http://127.0.0.1:${port}/index.html`,{waitUntil:"domcontentloaded"});
    await page.waitForFunction(()=>document.documentElement.dataset.fwBoot==="ready",{timeout:20000});

    const mobile=await page.evaluate(()=>{
      const rect=selector=>{
        const r=document.querySelector(selector).getBoundingClientRect();
        return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height};
      };
      const thumbs=[...document.querySelectorAll(".shared-dual-track .shared-dual-thumb")].map(el=>{
        const r=el.getBoundingClientRect(),grip=getComputedStyle(el,"::after");
        return {width:r.width,height:r.height,radii:[grip.borderTopLeftRadius,grip.borderTopRightRadius,
          grip.borderBottomRightRadius,grip.borderBottomLeftRadius]};
      });
      const source=document.querySelector("#source-region"),hud=document.querySelector("#runtime-hud");
      const workbench=document.querySelector("#virtual-root-workbench"),toggle=document.querySelector("#rational-enabled");
      return {graph:rect(".workspace-right"),aux:rect(".sine-monitor"),controls:rect(".quick-panel"),
        source:{top:source.getBoundingClientRect().top,bottom:source.getBoundingClientRect().bottom},
        hudInsideSource:source.contains(hud),exportInsideSource:source.contains(document.querySelector(".offline-tool")),
        exportTop:document.querySelector(".offline-tool").getBoundingClientRect().top,
        exportShortcut:Boolean(document.querySelector("#export-jump")),exportToggle:Boolean(document.querySelector("#export-toggle")),
        redundantHarmonicDetails:Boolean(document.querySelector("#harmonic-placement-details")),
        harmonicToggleLabel:toggle?.closest("label")?.parentElement===workbench,
        railHeights:[...document.querySelectorAll(".shared-dual-track")].map(el=>el.getBoundingClientRect().height),thumbs};
    });
    assert.ok(mobile.aux.top>=mobile.graph.bottom-1&&mobile.aux.top<mobile.controls.top&&
      Math.abs(mobile.aux.left-mobile.graph.left)<=2&&Math.abs(mobile.aux.right-mobile.graph.right)<=2,
      "mobile auxiliary tone must use the full graph width below the graph and before transform controls: "+JSON.stringify(mobile));
    assert.ok(mobile.hudInsideSource&&mobile.source.top<=mobile.source.bottom,
      "idle processing status must stay within the source panel instead of becoming a separate workspace row");
    assert.ok(mobile.exportInsideSource&&!mobile.exportShortcut&&mobile.exportToggle&&
      mobile.exportTop<mobile.source.bottom,
      "the actual WAV export disclosure must be directly available in the source panel");
    assert.ok(!mobile.redundantHarmonicDetails&&mobile.harmonicToggleLabel,
      "the existing harmonic checkbox must sit directly in the workbench without a second disclosure");
    assert.ok(mobile.railHeights.every(height=>height<=38)&&mobile.thumbs.every((thumb,index)=>{
      const half=index%2===0?thumb.radii[0]==="9px"&&thumb.radii[1]==="9px"&&
        thumb.radii[2]==="1px"&&thumb.radii[3]==="1px":
        thumb.radii[0]==="1px"&&thumb.radii[1]==="1px"&&
        thumb.radii[2]==="9px"&&thumb.radii[3]==="9px";
      return thumb.width>=24&&thumb.height>=24&&half;
    }),
      "shared range rails must be compact with touch-sized, visibly half-rounded grips: "+JSON.stringify(mobile));
    await page.click("#export-toggle");
    assert.equal(await page.$eval(".offline-tool",el=>el.open),true,
      "the export summary must open its real nearby export controls");

    await page.setViewport({width:1365,height:900,deviceScaleFactor:1});
    const desktop=await page.evaluate(()=>{
      const rect=selector=>{
        const r=document.querySelector(selector).getBoundingClientRect();
        return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width};
      };
      return {graph:rect(".workspace-right"),aux:rect(".sine-monitor"),controls:rect(".quick-panel")};
    });
    assert.ok(desktop.aux.top>=desktop.graph.bottom-1&&desktop.aux.left>=desktop.graph.left-2&&
      Math.abs(desktop.aux.right-desktop.graph.right)<=2&&desktop.aux.left>desktop.controls.left,
      "desktop auxiliary tone must occupy the graph's lower-right work area: "+JSON.stringify(desktop));
    assert.deepEqual(errors,[],"responsive page must not log JavaScript errors");
  }finally{
    await browser?.close();
    server.kill();
  }
});
