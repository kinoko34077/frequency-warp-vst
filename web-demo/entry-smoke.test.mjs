/** Acceptance smoke for the *deployed artifact*, not the source tree.
 * WARP_ENTRY_URL=... verifies GitHub Pages after deploy; otherwise serve
 * _site locally. Explicitly exercises the two user-reported broken controls.
 */
import {test} from "node:test";
import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {mkdtemp,writeFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join,resolve} from "node:path";
import puppeteer from "puppeteer-core";

function shortWav(){
  const rate=16000,frames=rate,wav=Buffer.alloc(44+frames*2);
  wav.write("RIFF",0);wav.writeUInt32LE(wav.length-8,4);
  wav.write("WAVE",8);wav.write("fmt ",12);wav.writeUInt32LE(16,16);
  wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);
  wav.writeUInt32LE(rate,24);wav.writeUInt32LE(rate*2,28);
  wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);
  wav.write("data",36);wav.writeUInt32LE(frames*2,40);
  for(let i=0;i<frames;i++)wav.writeInt16LE(Math.round(10000*Math.sin(2*Math.PI*440*i/rate)),44+i*2);
  return wav;
}
const liveUrl=process.env.WARP_ENTRY_URL?.trim();
test("Pages entry: mobile settings opens and tapping the visible source opens native file chooser",async()=>{
  const root=await mkdtemp(join(tmpdir(),"warp-entry-"));
  const server=liveUrl?null:spawn("python3",["-m","http.server","8766","--bind","127.0.0.1"],{
    cwd:resolve(process.env.WARP_WEB_ROOT||"_site"),stdio:"ignore"
  });
  let browser;
  try{
    const wav=join(root,"picker.wav");await writeFile(wav,shortWav());
    browser=await puppeteer.launch({
      executablePath:process.env.CHROME_BIN||"/usr/bin/google-chrome",
      headless:true,
      args:["--no-sandbox","--disable-dev-shm-usage","--autoplay-policy=no-user-gesture-required"]
    });
    const page=await browser.newPage();
    await page.setViewport({width:390,height:844,deviceScaleFactor:2,isMobile:true,hasTouch:true});
    const errors=[];
    page.on("pageerror",e=>errors.push(String(e.message)));
    page.on("response",r=>{
      if(r.status()>=400 && /\.(mjs|js|wasm|css)(\?|$)/.test(r.url()))
        errors.push(r.status()+" "+r.url());
    });
    const url=liveUrl||"http://127.0.0.1:8766/index.html";
    let boot=false,lastError="";
    // GitHub Pages propagation/cold-edge cache can take a few requests. Only
    // the final, fully functional public entry is considered acceptable.
    for(let attempt=0;attempt<12&&!boot;attempt++){
      try{
        const resp=await page.goto(url,{waitUntil:"domcontentloaded",timeout:16000});
        if(!resp?.ok())throw Error("HTTP "+resp?.status());
        await page.waitForFunction(()=>
          document.documentElement.dataset.fwBoot==="ready", {timeout:12000});
        await page.waitForFunction(()=>
          document.querySelector("#mini-fundamental")?.textContent.includes("→"),{timeout:12000});
        boot=true;
      }catch(e){
        lastError=e.message;
        await new Promise(resolve=>setTimeout(resolve,1200));
      }
    }
    assert.ok(boot,"Public app modules did not load: "+lastError+"; "+errors.join("; "));
    await page.click("#settings-open");
    assert.equal(await page.$eval("#settings-dialog",el=>el.open),true,
      "Settings must open from touch-size header button");
    const scroll=await page.$eval(".settings-body",el=>({
      max:el.scrollHeight-el.clientHeight,
      scrollable:getComputedStyle(el).overflowY
    }));
    assert.ok(scroll.max>25 && scroll.scrollable==="auto",
      "mobile settings must scroll: "+JSON.stringify(scroll));
    await page.click("#settings-done");
    assert.equal(await page.$eval("#settings-dialog",el=>el.open),false);
    const [chooser]=await Promise.all([
      page.waitForFileChooser({timeout:9000}),
      page.click("#drop")
    ]);
    assert.ok(chooser,"Tapping visible source must invoke native file picker");
    await chooser.accept([wav]);
    await page.waitForFunction(()=>
      !document.querySelector("#play-wet").disabled &&
      document.querySelector("#file-meta").textContent.includes("picker.wav"),
      {timeout:23000});
    assert.deepEqual(errors,[],"No missing module/asset or JavaScript runtime errors");
    if(!liveUrl){
      // Deliberately fail a large module import. Independent entry-controls.js
      // and the real file input must STILL open settings and the native picker.
      const degraded=await browser.newPage();
      await degraded.setViewport({width:390,height:844,isMobile:true,hasTouch:true});
      await degraded.setRequestInterception(true);
      degraded.on("request",req=>{
        if(req.url().endsWith("/engine-policy.mjs"))req.abort("failed");
        else req.continue();
      });
      await degraded.goto(url,{waitUntil:"domcontentloaded"});
      await degraded.click("#settings-open");
      assert.equal(await degraded.$eval("#settings-dialog",el=>el.open),true,
        "Independent settings entry must work even when a DSP dependency fails");
      await degraded.click("#settings-done");
      const [fallbackChooser]=await Promise.all([
        degraded.waitForFileChooser({timeout:9000}),
        degraded.click("#drop")
      ]);
      assert.ok(fallbackChooser,"Native picker must work even if app.mjs fails");
      await fallbackChooser.cancel();
      await degraded.close();
    }
    await page.close();
  }finally{
    if(browser)await browser.close();
    if(server)server.kill("SIGTERM");
    await rm(root,{recursive:true,force:true});
  }
});
