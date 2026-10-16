import test from "node:test";
import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {resolve} from "node:path";
import puppeteer from "puppeteer-core";

// #236: real Chromium behavior at the staged Pages origin, not a DOM mock.
test("#236 failed import and late ON must not misrepresent current debug state", async () => {
  const server=spawn("python3",["-m","http.server","8798","--bind","127.0.0.1"],{
    cwd:resolve(process.env.WARP_WEB_ROOT||"_site"),stdio:"ignore"
  });
  let browser;
  try {
    browser=await puppeteer.launch({
      executablePath:process.env.CHROME_BIN||"/usr/bin/google-chrome",
      headless:true,args:["--no-sandbox","--disable-dev-shm-usage"]
    });
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
