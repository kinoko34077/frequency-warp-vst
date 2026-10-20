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
    // Mobile diagnostics must not begin as a wide fixed overlay over the graph
    // or pivot linker; the user can explicitly restore full detail.
    assert.equal(await page.$eval("#runtime-hud",el=>el.classList.contains("is-hidden")),true);
    const badgeWidth=await page.$eval("#runtime-hud-restore",el=>el.getBoundingClientRect().width);
    await page.evaluate(()=>{
      const s=document.querySelector("#status");
      s.dataset.kind="error";
      s.textContent="テスト用の音声エラー";
    });
    await page.waitForFunction(()=>
      document.querySelector("#runtime-hud-brief").textContent.includes("テスト用の音声エラー"));
    const warningWidth=await page.$eval("#runtime-hud-restore",el=>el.getBoundingClientRect().width);
    assert.ok(Math.abs(badgeWidth-warningWidth)<1,
      "Audio warnings must not resize and move the compact status button");
    await page.evaluate(()=>{
      const s=document.querySelector("#status");
      s.dataset.kind="info";
      s.textContent="音声ファイルを選択してください。";
    });
    await page.click("#runtime-hud-restore");
    assert.equal(await page.$eval("#runtime-hud",el=>el.classList.contains("is-hidden")),false);
    await page.click("#runtime-hud-hide");
    for(const width of [320,390]){
      await page.setViewport({width,height:844,deviceScaleFactor:2,isMobile:true,hasTouch:true});
      const hit=await page.$eval("#pivot-link-target",el=>{
        el.scrollIntoView({block:"center"});
        const b=el.getBoundingClientRect(),x=b.left+b.width/2,y=b.top+b.height/2;
        const under=document.elementFromPoint(x,y);
        const left=document.querySelector(".quick-panel").getBoundingClientRect();
        const right=document.querySelector(".workspace-right").getBoundingClientRect();
        const graph=document.querySelector("#curve").getBoundingClientRect();
        return {target:under===el||el.contains(under),
          leftRight:left.right,rightLeft:right.left,graphW:graph.width,graphH:graph.height,
          overflow:document.documentElement.scrollWidth>innerWidth};
      });
      assert.ok(hit.target,"Mobile status must not intercept physical pivot link at "+width+": "+JSON.stringify(hit));
      assert.ok(hit.leftRight<=hit.rightLeft+1&&Math.abs(hit.graphW-hit.graphH)<2&&!hit.overflow,
        "Keep compact LEFT controls / RIGHT square graph at "+width+": "+JSON.stringify(hit));
      const exportTarget=await page.$eval("#export-jump",el=>{
        el.scrollIntoView({block:"center"});
        const r=el.getBoundingClientRect(),under=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);
        return {height:r.height,width:r.width,reachable:under===el||el.contains(under)};
      });
      assert.ok(exportTarget.height>=40&&exportTarget.reachable,
        "Mobile "+width+"px WAV shortcut must have a reachable 40px hit target: "+JSON.stringify(exportTarget));
    }
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
    assert.equal(await page.evaluate(()=>document.activeElement?.id),"settings-open");
    await page.click("#settings-inline");
    assert.equal(await page.$eval("#settings-dialog",el=>el.open),true);
    await page.click("#settings-close");
    assert.equal(await page.evaluate(()=>document.activeElement?.id),"settings-inline",
      "Closing settings must restore the workbench trigger, not jump to header");
    // Browser Escape is a separate native close path.
    await page.click("#settings-inline");
    await page.keyboard.press("Escape");
    assert.equal(await page.evaluate(()=>document.activeElement?.id),"settings-inline");
    // The native File must remain associated with its input while the
    // asynchronous read begins, especially for iOS FileProvider-backed files.
    await page.evaluate(()=>{
      const original=File.prototype.arrayBuffer;
      window.__pickerAttachedAtRead=null;
      File.prototype.arrayBuffer=function(...args){
        const field=document.querySelector("#audio-file");
        window.__pickerAttachedAtRead=Array.from(field.files).includes(this);
        return original.apply(this,args);
      };
    });
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
    assert.equal(await page.evaluate(()=>window.__pickerAttachedAtRead),true,
      "Do not clear native file input before its asynchronous File.arrayBuffer read");
    await page.waitForFunction(()=>document.querySelector("#audio-file").files.length===0,
      {timeout:4000});
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
    assert.match(await page.$eval("#file-meta",el=>el.textContent),/読込失敗/,
      "Collapsed mobile HUD must not hide the actual failure next to source picker");
    await page.waitForFunction(()=>document.querySelector("#audio-file").files.length===0,
      {timeout:4000});
    // Replacing with another valid file still succeeds after the failure.
    await (await page.$("#audio-file")).uploadFile(wav);
    await page.waitForFunction(()=>
      document.querySelector("#status").textContent.includes("読み込み完了。再生できます。"),{
      timeout:30000
    });
    assert.equal(await page.$eval("#play-wet",el=>el.disabled),false);
    // #79 M3 exact single-source Wet: typed %, coarse range, A/B and reset.
    const setWet=percent=>page.$eval("#wet-value",(el,value)=>{
      el.value=value;el.dispatchEvent(new Event("input",{bubbles:true}));
    },String(percent));
    const canonicalWet=()=>page.$eval("#wet-value",el=>Number(el.dataset.fwCanonical));
    await setWet("12.345");
    assert.ok(Math.abs(await canonicalWet()-.12345)<1e-12,
      "typed 12.345% must not be quantized to the coarse slider step");
    assert.equal(await page.$eval("#wet-value",el=>el.value),"12.345");
    const railProxy=Number(await page.$eval("#wet",el=>el.value));
    assert.ok(Math.abs(railProxy-.125)<1e-9,
      "range is only a 0.005-spaced gesture/view proxy");
    // #79 second fraction: A reverb 33.333% retains exact .33333 even
    // though its native slider is one whole percentage per gesture.
    const setAReverb=percent=>page.$eval("#a-reverb-value",(el,value)=>{
      el.value=String(value);el.dispatchEvent(new Event("input",{bubbles:true}));
    },percent);
    const canonicalAReverb=()=>page.$eval("#a-reverb-value",el=>Number(el.dataset.fwCanonical));
    await page.click("#settings-open");
    await setAReverb("33.333");
    await page.click("#settings-done");
    assert.ok(Math.abs(await canonicalAReverb()-.33333)<1e-12);
    assert.equal(await page.$eval("#a-reverb",el=>Number(el.value)),33);
    // Reflection synthesis gain stores an exact fraction, while dual-thumb
    // movement remains constrained to whole-percent gesture positions.
    const setReflectGain=percent=>page.$eval("#zero-reflect-value",(el,value)=>{
      el.value=String(value);el.dispatchEvent(new Event("input",{bubbles:true}));
    },percent);
    const canonicalReflectGain=()=>page.$eval("#zero-reflect-value",
      el=>Number(el.dataset.fwCanonical));
    await setReflectGain("37.125");
    assert.ok(Math.abs(await canonicalReflectGain()-.37125)<1e-12);
    assert.equal(await page.$eval("#zero-reflect",el=>Number(el.value)),37);
    const setReflectDecay=percent=>page.$eval("#zero-decay-value",(el,value)=>{
      el.value=String(value);el.dispatchEvent(new Event("input",{bubbles:true}));
    },percent);
    const canonicalReflectDecay=()=>page.$eval("#zero-decay-value",
      el=>Number(el.dataset.fwCanonical));
    await setReflectDecay("12.345");
    assert.ok(Math.abs(await canonicalReflectDecay()-.12345)<1e-12);
    assert.equal(await page.$eval("#zero-decay",el=>Number(el.value)),12);
    const setInvert=percent=>page.$eval("#invert-value",(el,value)=>{
      el.value=String(value);el.dispatchEvent(new Event("input",{bubbles:true}));
    },percent);
    const canonicalInvert=()=>page.$eval("#invert-value",
      el=>Number(el.dataset.fwCanonical));
    await setInvert("34.567");
    assert.ok(Math.abs(await canonicalInvert()-.34567)<1e-12);
    assert.ok(Math.abs(await page.$eval("#invert",el=>Number(el.value))-.345)<1e-9);
    await page.click("#compare-save-a");
    await setWet("50");
    await page.click("#settings-open");
    await setAReverb("75");
    await page.click("#settings-done");
    await setReflectGain("80");
    await setReflectDecay("80");
    await setInvert("70");
    await page.click("#compare-save-b");
    await page.click("#compare-load-a");
    assert.ok(Math.abs(await canonicalWet()-.12345)<1e-12,
      "A/B restore must retain Float64, not slider proxy");
    assert.equal(await page.$eval("#wet-value",el=>el.value),"12.345");
    assert.ok(Math.abs(await canonicalAReverb()-.33333)<1e-12,
      "A/B restores reverb Float64 independently of whole-percent slider");
    assert.ok(Math.abs(await canonicalReflectGain()-.37125)<1e-12,
      "A/B must preserve reflection gain Float64, not the 37% dual thumb proxy");
    assert.equal(await page.$eval("#zero-reflect",el=>Number(el.value)),37);
    assert.ok(Math.abs(await canonicalReflectDecay()-.12345)<1e-12,
      "A/B must preserve reflection decay Float64 rather than integer thumb");
    assert.equal(await page.$eval("#zero-decay",el=>Number(el.value)),12);
    assert.ok(Math.abs(await canonicalInvert()-.34567)<1e-12,
      "A/B must preserve inversion Float64 rather than 0.005 shape thumb");
    await page.click("#compare-load-b");
    assert.equal(await canonicalWet(),.5);
    assert.equal(await canonicalAReverb(),.75);
    assert.equal(await canonicalReflectGain(),.8);
    assert.equal(await canonicalReflectDecay(),.8);
    assert.equal(await canonicalInvert(),.7);
    await page.$eval("#invert-value",el=>{
      el.value="";el.dispatchEvent(new Event("input",{bubbles:true}));
    });
    assert.equal(await canonicalInvert(),.7,"empty inversion input preserves accepted value");
    await page.$eval("#zero-decay-value",el=>{
      el.value="";el.dispatchEvent(new Event("input",{bubbles:true}));
    });
    assert.equal(await canonicalReflectDecay(),.8,
      "empty reflection decay input must preserve last canonical value");
    await page.$eval("#zero-reflect-value",el=>{
      el.value="";el.dispatchEvent(new Event("input",{bubbles:true}));
    });
    assert.equal(await canonicalReflectGain(),.8,
      "empty reflection gain must not replace the last valid processed setting");
    await page.$eval("#a-reverb-value",el=>{
      el.value="";el.dispatchEvent(new Event("input",{bubbles:true}));
    });
    assert.equal(await canonicalAReverb(),.75,
      "empty typed reverb must preserve last accepted DSP value");
    await page.$eval("#wet-value",el=>{
      el.value="";el.dispatchEvent(new Event("input",{bubbles:true}));
    });
    assert.equal(await canonicalWet(),.5,"empty typed edit must preserve last accepted Mix");
    await page.click("#settings-open");
    await page.click("#settings-reset");
    await page.click("#settings-done");
    assert.equal(await canonicalWet(),1,"Reset must restore the single binding, not stale precise state");
    assert.equal(Number(await page.$eval("#wet",el=>el.value)),1);
    assert.equal(await canonicalAReverb(),0,"Reset restores reverb binding to zero");
    assert.equal(Number(await page.$eval("#a-reverb",el=>el.value)),0);
    assert.equal(await canonicalReflectGain(),1,"reset restores full reflection gain");
    assert.equal(await page.$eval("#zero-reflect",el=>Number(el.value)),100);
    assert.equal(await canonicalReflectDecay(),0,"reset must return reflect decay to zero");
    assert.equal(await page.$eval("#zero-decay",el=>Number(el.value)),0);
    assert.equal(await canonicalInvert(),0,"reset returns inversion to 0%");
    assert.equal(await page.$eval("#invert",el=>Number(el.value)),0);
    // The Rust offline renderer has ALREADY removed stream lookahead and
    // flushed the tail. The saved WAV must therefore mix Dry and processed
    // samplewise, unlike the latency-compensated *realtime* AudioWorklet.
    await page.click(".offline-tool summary");
    await page.click("#render");
    await page.waitForFunction(()=>
      !document.querySelector("#download").disabled,{timeout:30000});
    await page.evaluate(()=>{
      window.__capturedWavs=[];
      const native=URL.createObjectURL.bind(URL);
      URL.createObjectURL=blob=>{
        window.__capturedWavs.push(blob);return native(blob);
      };
    });
    for(const wet of [0,.5,1]){
      await page.$eval("#wet",(el,v)=>{
        el.value=String(v);el.dispatchEvent(new Event("input",{bubbles:true}));
      },wet);
      await page.click("#download");
    }
    const rendered=await page.evaluate(async()=>{
      const blobs=window.__capturedWavs;
      const views=await Promise.all(blobs.map(async blob=>new DataView(await blob.arrayBuffer())));
      if(views.length!==3)return {exports:views.length};
      const rate=views[0].getUint32(24,true);
      const frames=(views[0].byteLength-44)/2;
      let error=0,distinct=false,nonzero=0;
      for(let i=0;i<frames;i++){
        const offset=44+i*2;
        const dry=views[0].getInt16(offset,true),mid=views[1].getInt16(offset,true),
          wet=views[2].getInt16(offset,true);
        error=Math.max(error,Math.abs(mid-(dry+wet)/2));
        if(Math.abs(dry-wet)>100)distinct=true;
        nonzero=Math.max(nonzero,Math.abs(mid));
      }
      return {exports:views.length,rate,frames,error,distinct,nonzero};
    });
    assert.equal(rendered.exports,3,"Wet 0, 50 and 100% must each export a WAV");
    assert.equal(rendered.frames,rendered.rate,
      "one-second WAV length must follow the decoded AudioContext rate: "+JSON.stringify(rendered));
    assert.ok(rendered.error<=3,
      "actual WAV Wet 50% is not an aligned samplewise mix: "+JSON.stringify(rendered));
    assert.ok(rendered.distinct&&rendered.nonzero>100,
      "real dry and wet outputs must not be trivial silence: "+JSON.stringify(rendered));
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
