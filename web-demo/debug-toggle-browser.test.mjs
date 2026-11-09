import test from "node:test";
import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {resolve} from "node:path";
import puppeteer from "puppeteer-core";

// #236: real Chromium behavior at the staged Pages origin, not a DOM mock.
test("#236 failed import and late ON must not misrepresent current debug state", async () => {
  const python=process.env.PYTHON_BIN||(process.platform==="win32"?"python":"python3");
  const server=spawn(python,["-m","http.server","8798","--bind","127.0.0.1"],{
    cwd:resolve(process.env.WARP_WEB_ROOT||"_site"),stdio:"ignore"
  });
  let browser;
  try {
    browser=await puppeteer.launch({
      executablePath:process.env.CHROME_BIN||"/usr/bin/google-chrome",
      headless:true,args:["--no-sandbox","--disable-dev-shm-usage"]
    });
    const settings=await browser.newPage();
    await settings.goto("http://127.0.0.1:8798/index.html",{waitUntil:"domcontentloaded"});
    await settings.click("#settings-open");
    const collapsed=await settings.evaluate(()=>({
      engineValues:[...document.querySelectorAll("#engine option")].map(option=>option.value),
      resetLabel:document.querySelector("#settings-reset").textContent.trim(),
      lowDisclosure:Boolean(document.querySelector("#low-frequency-capability-details"))&&
        !document.querySelector("#low-frequency-capability-details").open,
      prototypeDisclosure:Boolean(document.querySelector("#prototype-info"))&&
        !document.querySelector("#prototype-info").open,
      developerDisclosure:Boolean(document.querySelector("#developer-tools"))&&
        !document.querySelector("#developer-tools").open,
      debugChecked:document.querySelector("#debug-mode").checked
    }));
    assert.deepEqual(collapsed,{
      engineValues:["0","1"],resetLabel:"操作値を初期値に戻す",
      lowDisclosure:true,prototypeDisclosure:true,developerDisclosure:true,debugChecked:false
    },"the normal settings view should stay compact and describe only available operations");
    await settings.click("#prototype-info > summary");
    await settings.click("#developer-tools > summary");
    assert.equal(await settings.$eval("#debug-mode",el=>el.getBoundingClientRect().height>0),true,
      "the user can still reach the developer switch through its disclosure");
    await settings.close();

    const active=await browser.newPage();
    await active.evaluateOnNewDocument(()=>localStorage.setItem("frequency-warp:debug-mode:v1","1"));
    await active.setRequestInterception(true);
    active.on("request",request=>request.url().endsWith("/visual-editor.mjs")?
      void request.respond({status:200,contentType:"text/javascript",body:"export {};"}):
      void request.continue());
    await active.goto("http://127.0.0.1:8798/index.html",{waitUntil:"domcontentloaded"});
    assert.deepEqual(await active.evaluate(()=>({
      checked:document.querySelector("#debug-mode").checked,
      aboutOpen:document.querySelector("#prototype-info").open,
      developerOpen:document.querySelector("#developer-tools").open
    })),{checked:true,aboutOpen:true,developerOpen:true},
      "an already active debug mode remains discoverable after it moves under disclosures");
    await active.close();

    const page=await browser.newPage();
    await page.setRequestInterception(true);
    page.on("request",req=>req.url().endsWith("/visual-editor.mjs")?
      req.abort("failed"):req.continue());
    await page.goto("http://127.0.0.1:8798/index.html",{waitUntil:"domcontentloaded"});
    await page.evaluate(()=>{
      const el=document.querySelector("#debug-mode");
      el.checked=true;el.dispatchEvent(new Event("change",{bubbles:true}));
    });
    await page.waitForFunction(()=>!document.querySelector("#debug-mode-feedback").hidden);
    const failure=await page.evaluate(()=>({
      checked:document.querySelector("#debug-mode").checked,
      message:document.querySelector("#debug-mode-feedback").textContent,
      saved:localStorage.getItem("frequency-warp:debug-mode:v1")
    }));
    assert.equal(failure.checked,false);
    assert.equal(failure.saved,"0");
    assert.match(failure.message,/再度オンにしてください/);
    await page.close();

    const race=await browser.newPage();
    await race.setRequestInterception(true);
    race.on("request",req=>{
      if(req.url().endsWith("/visual-editor.mjs")){
        setTimeout(()=>{void req.continue().catch(()=>{});},600);
      }else void req.continue();
    });
    await race.goto("http://127.0.0.1:8798/index.html",{waitUntil:"domcontentloaded"});
    await race.evaluate(()=>{
      const el=document.querySelector("#debug-mode");
      el.checked=true;el.dispatchEvent(new Event("change",{bubbles:true}));
    });
    await new Promise((resolve) => setTimeout(resolve, 70));
    await race.evaluate(()=>{
      const el=document.querySelector("#debug-mode");
      el.checked=false;el.dispatchEvent(new Event("change",{bubbles:true}));
    });
    await race.waitForFunction(()=>Boolean(document.querySelector("#fw-layout-inspector")), {timeout:10000});
    await race.waitForFunction(()=>document.querySelector("#fw-layout-inspector").hidden);
    const disabled=await race.evaluate(()=>({
      checked:document.querySelector("#debug-mode").checked,
      saved:localStorage.getItem("frequency-warp:debug-mode:v1"),
      visible:!document.querySelector("#fw-layout-inspector").hidden,
      css:document.querySelector("#fw-layout-overrides").textContent
    }));
    assert.deepEqual(disabled,{checked:false,saved:"0",visible:false,css:""});
    await race.evaluate(()=>{
      const el=document.querySelector("#debug-mode");
      el.checked=true;el.dispatchEvent(new Event("change",{bubbles:true}));
    });
    await race.waitForFunction(()=>document.querySelector("#fw-layout-inspector") &&
      !document.querySelector("#fw-layout-inspector").hidden);
    assert.equal(await race.$eval("#debug-mode",el=>el.checked),true);
    await race.close();
  }finally{
    if(browser)await browser.close();
    server.kill("SIGTERM");
  }
});
