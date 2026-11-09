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
        const r=el.getBoundingClientRect(),body=getComputedStyle(el,"::before"),grip=getComputedStyle(el,"::after");
        return {width:r.width,height:r.height,bodyHeight:body.height,
          bodyRadii:[body.borderTopLeftRadius,body.borderTopRightRadius,
            body.borderBottomRightRadius,body.borderBottomLeftRadius],radii:[grip.borderTopLeftRadius,grip.borderTopRightRadius,
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
    assert.ok(mobile.railHeights.every(height=>height<=32)&&mobile.thumbs.every((thumb,index)=>{
      const topHalf=index%2===0?thumb.bodyRadii[0]==="14px"&&thumb.bodyRadii[1]==="14px"&&
        thumb.bodyRadii[2]==="0px"&&thumb.bodyRadii[3]==="0px":
        thumb.bodyRadii[0]==="0px"&&thumb.bodyRadii[1]==="0px"&&
        thumb.bodyRadii[2]==="14px"&&thumb.bodyRadii[3]==="14px";
      const gripHalf=index%2===0?thumb.radii[0]==="6px"&&thumb.radii[1]==="6px"&&
        thumb.radii[2]==="0px"&&thumb.radii[3]==="0px":
        thumb.radii[0]==="0px"&&thumb.radii[1]==="0px"&&
        thumb.radii[2]==="6px"&&thumb.radii[3]==="6px";
      return thumb.width>=28&&thumb.height>=28&&thumb.bodyHeight==="14px"&&topHalf&&gripHalf;
    }),
      "shared range rails must stay 30px compact with 28px touch targets and genuinely semicircular split thumbs: "+JSON.stringify(mobile));
    await page.tap("#sine-enabled");
    assert.equal(await page.$eval("#sine-enabled",el=>el.checked),true,
      "mobile auxiliary tone playback must remain reachable beneath the sticky graph");
    await page.tap("#sine-enabled");
    assert.equal(await page.$eval("#sine-enabled",el=>el.checked),false);
    await page.evaluate(()=>{
      for(const id of ["zero-reflect","zero-decay"]){
        const input=document.querySelector("#"+id);input.value="50";
        input.dispatchEvent(new Event("input",{bubbles:true}));
      }
    });
    await page.$eval("#reflection-dual",el=>el.scrollIntoView({block:"center"}));
    const halves=await page.$eval("#reflection-dual",el=>{
      const rail=el.getBoundingClientRect(),inner=el.querySelector("[data-dual-inner]").getBoundingClientRect();
      const upper=el.querySelector(".shared-dual-thumb.upper").getBoundingClientRect();
      const lower=el.querySelector(".shared-dual-thumb.lower").getBoundingClientRect();
      return {upper:{left:upper.left,right:upper.right,top:upper.top,bottom:upper.bottom},
        lower:{left:lower.left,right:lower.right,top:lower.top,bottom:lower.bottom},
        upperTap:{x:inner.left+inner.width*.5+4,y:inner.top+6},
        lowerTap:{x:inner.left+inner.width*.5-4,y:inner.bottom-6},rail:{top:rail.top,bottom:rail.bottom}};
    });
    assert.ok(halves.upper.left<halves.lower.right&&halves.upper.right>halves.lower.left&&
      halves.upper.top<halves.lower.bottom&&halves.upper.bottom>halves.lower.top,
      "the overlap regression must place both 28px targets at the same value: "+JSON.stringify(halves));
    const upperHit=await page.evaluate(({x,y})=>{
      const target=document.elementFromPoint(x,y);
      return {x,y,target:target?.id||target?.className||target?.tagName,
        viewport:{width:innerWidth,height:innerHeight},scrollY,track:document.querySelector("#reflection-dual").getBoundingClientRect().toJSON()};
    },halves.upperTap);
    await page.touchscreen.tap(halves.upperTap.x,halves.upperTap.y);
    assert.notEqual(await page.$eval("#zero-reflect",el=>Number(el.value)),50,
      "touching the visible upper semicircle must move the upper value: "+JSON.stringify({halves,upperHit,
        values:await page.evaluate(()=>[Number(document.querySelector("#zero-reflect").value),Number(document.querySelector("#zero-decay").value)])}));
    assert.equal(await page.$eval("#zero-decay",el=>Number(el.value)),50,
      "an overlapping lower hit target must not steal an upper semicircle touch");
    await page.evaluate(()=>{
      for(const id of ["zero-reflect","zero-decay"]){
        const input=document.querySelector("#"+id);input.value="50";
        input.dispatchEvent(new Event("input",{bubbles:true}));
      }
    });
    await page.touchscreen.tap(halves.lowerTap.x,halves.lowerTap.y);
    assert.equal(await page.$eval("#zero-reflect",el=>Number(el.value)),50,
      "touching the visible lower semicircle must leave the upper value unchanged");
    assert.notEqual(await page.$eval("#zero-decay",el=>Number(el.value)),50,
      "the lower value must receive a touch on its own visible semicircle");
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
    // Reopen at desktop viewport so the intentionally compact mobile badge
    // does not hide the drag handle while this test checks its floating surface.
    await page.goto(`http://127.0.0.1:${port}/index.html`,{waitUntil:"domcontentloaded"});
    await page.waitForFunction(()=>document.documentElement.dataset.fwBoot==="ready",{timeout:20000});
    const hudHead=await page.$eval("#runtime-hud-head",el=>{
      const r=el.getBoundingClientRect();return {x:r.left+20,y:r.top+r.height/2};
    });
    await page.mouse.move(hudHead.x,hudHead.y);
    await page.mouse.down();
    await page.mouse.move(hudHead.x+40,hudHead.y+32,{steps:3});
    await page.mouse.up();
    const floatingHud=await page.$eval("#runtime-hud",el=>{
      const style=getComputedStyle(el);
      return {floating:el.classList.contains("is-floating"),background:style.backgroundColor,
        borderWidth:style.borderTopWidth,shadow:style.boxShadow};
    });
    assert.ok(floatingHud.floating&&floatingHud.background!=="rgba(0, 0, 0, 0)"&&
      Number.parseFloat(floatingHud.borderWidth)>0&&floatingHud.shadow!=="none",
      "a deliberately dragged status panel must regain its readable floating surface: "+JSON.stringify(floatingHud));
    assert.deepEqual(errors,[],"responsive page must not log JavaScript errors");
  }finally{
    await browser?.close();
    server.kill();
  }
});
