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

function shortWav(seconds=1){
  const rate=16000,frames=Math.max(1,Math.round(rate*seconds)),wav=Buffer.alloc(44+frames*2);
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
    // Failed replacement must leave the previously decoded sample ready to
    // play and export, without forcing the user to re-select it.
    const bad=join(root,"too-short.wav");await writeFile(bad,shortWav(.01));
    await (await page.$("#audio-file")).uploadFile(bad);
    await page.waitForFunction(()=>
      document.querySelector("#status").textContent.includes("音声を開けませんでした"),{
      timeout:30000
    });
    assert.match(await page.$eval("#file-meta",el=>el.textContent),/picker\.wav/);
    assert.equal(await page.$eval("#play-wet",el=>el.disabled),false);
    assert.equal(await page.$eval("#render",el=>el.disabled),false);
    assert.match(await page.$eval("#status",el=>el.textContent),/以前の音声は保持/);
    // Replacing with another valid file still succeeds after the failure.
    await (await page.$("#audio-file")).uploadFile(wav);
    await page.waitForFunction(()=>
      document.querySelector("#status").textContent.includes("読み込み完了。再生できます。"),{
      timeout:30000
    });
    assert.equal(await page.$eval("#play-wet",el=>el.disabled),false);
    // Inspect real downloadable PCM, not merely Rust helper outputs. At Wet
    // 50%, the first 800 frames are pre-STFT latency. They must be silent
    // because BOTH processed and dry branches share the same timeline.
    await page.$eval("#wet",el=>{
      el.value=".5";el.dispatchEvent(new Event("input",{bubbles:true}));
    });
    await page.click(".offline-tool summary");
    await page.click("#render");
    await page.waitForFunction(()=>
      !document.querySelector("#download").disabled,{timeout:30000});
    await page.evaluate(()=>{
      window.__capturedWav=null;
      const native=URL.createObjectURL.bind(URL);
      URL.createObjectURL=blob=>{
        window.__capturedWav=blob;return native(blob);
      };
    });
    await page.click("#download");
    const rendered=await page.evaluate(async()=>{
      const blob=window.__capturedWav;
      if(!blob)return {hasBlob:false};
      const data=new DataView(await blob.arrayBuffer());
      const first=800,windowStart=2048,windowEnd=Math.min(5500,(data.byteLength-44)/2);
      let startupPeak=0,laterPeak=0;
      for(let i=0;i<first;i++)startupPeak=Math.max(startupPeak,
        Math.abs(data.getInt16(44+2*i,true)));
      for(let i=windowStart;i<windowEnd;i++)laterPeak=Math.max(laterPeak,
        Math.abs(data.getInt16(44+2*i,true)));
      return {hasBlob:true,startupPeak,laterPeak,frames:(data.byteLength-44)/2};
    });
    assert.ok(rendered.hasBlob&&rendered.frames===16000,
      "actual WAV export must produce the full selected clip: "+JSON.stringify(rendered));
    assert.ok(rendered.startupPeak<500,
      "offline 50%-Wet dry/wet timing mismatch leaked undelayed original at file start: "+JSON.stringify(rendered));
    assert.ok(rendered.laterPeak>100,
      "actual WAV output must retain audible signal after latency: "+JSON.stringify(rendered));
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
