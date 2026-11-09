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
    const transportWav=join(root,"transport.wav");await writeFile(transportWav,shortWav(8));
    browser=await puppeteer.launch({
      executablePath:process.env.CHROME_BIN||"/usr/bin/google-chrome",
      headless:true,
      args:["--no-sandbox","--disable-dev-shm-usage","--autoplay-policy=no-user-gesture-required"]
    });
    const page=await browser.newPage();
    await page.setViewport({width:390,height:844,deviceScaleFactor:2,isMobile:true,hasTouch:true});
    await page.evaluateOnNewDocument(()=>{
      const Native=window.AudioContext;
      if(!Native)return;
      window.__comparisonSourceStarts=[];
      window.AudioContext=class extends Native{
        createBufferSource(...args){
          const source=super.createBufferSource(...args);
          const start=source.start.bind(source);
          source.start=(when=0,offset=0,...rest)=>{
            window.__comparisonSourceStarts.push(offset);
            return start(when,offset,...rest);
          };
          return source;
        }
      };
    });
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
          document.querySelector("#vr-summary")?.textContent.includes("仮想基音"),{timeout:12000});
        boot=true;
      }catch(e){
        lastError=e.message;
        await new Promise(resolve=>setTimeout(resolve,1200));
      }
    }
    assert.ok(boot,"Public app modules did not load: "+lastError+"; "+errors.join("; "));
    assert.equal(await page.$eval("#virtual-root-workbench",el=>el.getClientRects().length>0),true,
      "User-goal virtual root control must be visible on published default entry");
    assert.equal(await page.$eval("#rational-enabled",el=>
      el.closest("#virtual-root-workbench")!==null),true,
      "Harmonic placement must be discoverable in the virtual-root workbench, not buried under effects");
    assert.equal(await page.$eval(".harmonic-mini",el=>el.getClientRects().length),0,
      "Original harmonic theory controls stay legacy-only in the normal Web UI");
    await page.setViewport({width:1280,height:900,deviceScaleFactor:1,isMobile:false,hasTouch:false});
    const desktopHud=await page.evaluate(()=>{
      const hud=document.querySelector("#runtime-hud").getBoundingClientRect();
      const graph=document.querySelector("#curve").getBoundingClientRect();
      const overlaps=!(hud.right<=graph.left||graph.right<=hud.left||
        hud.bottom<=graph.top||graph.bottom<=hud.top);
      return {position:getComputedStyle(document.querySelector("#runtime-hud")).position,
        overlaps,scrollWidth:document.documentElement.scrollWidth};
    });
    assert.equal(desktopHud.position,"static",
      "Audio status belongs in the source layout unless the user drags it");
    assert.equal(desktopHud.overlaps,false,
      "Desktop status must not cover the graph");
    await page.setViewport({width:390,height:844,deviceScaleFactor:2,isMobile:true,hasTouch:true});
    // Mobile diagnostics must not begin as a wide fixed overlay over the graph
    // or pivot linker; the user can explicitly restore full detail.
    assert.equal(await page.$eval("#runtime-hud",el=>el.classList.contains("is-hidden")),true);
    const mobileHud=await page.evaluate(()=>{
      const hud=document.querySelector("#runtime-hud").getBoundingClientRect();
      const rail=document.querySelector("#vr-step-m-rail").getBoundingClientRect();
      return {position:getComputedStyle(document.querySelector("#runtime-hud")).position,
        overlaps:!(hud.right<=rail.left||rail.right<=hud.left||
          hud.bottom<=rail.top||rail.bottom<=hud.top)};
    });
    assert.equal(mobileHud.position,"static",
      "The compact mobile status control must stay in document flow");
    assert.equal(mobileHud.overlaps,false,
      "Mobile status must not cover the virtual-root adjustment rail");
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
      const inputTarget=await page.$eval("#vr-target-h",el=>{
        el.scrollIntoView({block:"center"});
        const r=el.getBoundingClientRect(),under=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);
        return under===el||el.contains(under);
      });
      assert.equal(inputTarget,true,
        "Mobile status must not intercept virtual fundamental input at "+width+"px");
      const coView=await page.evaluate(()=>{
        const rail=document.querySelector("#axis-slope");
        rail.scrollIntoView({block:"center",inline:"nearest"});
        const r=rail.getBoundingClientRect(),g=document.querySelector("#curve").getBoundingClientRect();
        const p=document.querySelector(".workspace-right").getBoundingClientRect();
        return {railVisible:r.top>=0&&r.bottom<=innerHeight,
          graphVisible:g.top>=0&&g.bottom<=innerHeight,
          railGraphOverlap:!(r.right<=g.left||g.right<=r.left||r.bottom<=g.top||g.bottom<=r.top),
          railPanelOverlap:!(r.right<=p.left||p.right<=r.left||r.bottom<=p.top||p.bottom<=r.top),
          graphWidth:g.width,graphHeight:g.height,
          overflow:document.documentElement.scrollWidth>innerWidth};
      });
      assert.ok(coView.railVisible&&coView.graphVisible&&!coView.railGraphOverlap&&!coView.railPanelOverlap&&
        coView.graphWidth>=145&&Math.abs(coView.graphWidth-coView.graphHeight)<2&&!coView.overflow,
        "Mobile transform rail and its graph must stay visible together at "+width+"px: "+JSON.stringify(coView));
      const beforeSlope=await page.$eval("#axis-slope",el=>el.value);
      const railBox=await page.$eval("#axis-slope",el=>{
        const r=el.getBoundingClientRect();return {x:r.left,y:r.top,width:r.width,height:r.height};
      });
      const clickFraction=Number(beforeSlope)>0?0.1:0.9;
      await page.mouse.click(railBox.x+railBox.width*clickFraction,railBox.y+railBox.height/2);
      const afterSlope=await page.$eval("#axis-slope",el=>el.value);
      assert.notEqual(afterSlope,beforeSlope,
        "Mobile transform rail must remain operable while the graph is visible");
      const afterAdjustment=await page.evaluate(()=>{
        const r=document.querySelector("#axis-slope").getBoundingClientRect();
        const g=document.querySelector("#curve").getBoundingClientRect();
        return r.top>=0&&r.bottom<=innerHeight&&g.top>=0&&g.bottom<=innerHeight;
      });
      assert.equal(afterAdjustment,true,
        "The graph must remain in view after changing a mobile transform rail");
      const exportTarget=await page.$eval("#export-toggle",el=>{
        el.scrollIntoView({block:"center"});
        const r=el.getBoundingClientRect(),under=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);
        return {height:r.height,width:r.width,reachable:under===el||el.contains(under)};
      });
      assert.ok(exportTarget.height>=40&&exportTarget.reachable,
        "Mobile "+width+"px actual WAV export summary must have a reachable 40px hit target: "+JSON.stringify(exportTarget));
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
      const original=File.prototype.slice;
      window.__pickerAttachedAtRead=null;
      File.prototype.slice=function(...args){
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
      "Do not clear native file input before its asynchronous File.slice read");
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
    assert.equal(await page.$eval("#rational-enabled",el=>el.closest("label")?.parentElement?.id),
      "virtual-root-workbench","Harmonic audio processing must sit directly in its workbench");
    await page.click("#rational-enabled");
    await page.click("#play-wet");
    await page.waitForFunction(()=>!document.querySelector("#stop").disabled&&
      document.querySelector("#rt-indicator").textContent.includes("稼働中"),{timeout:25000});
    await page.click("#source-region > summary");
    assert.equal(await page.$eval("#source-region",el=>el.open),true,
      "Folding the source region during playback must keep Stop reachable");
    assert.equal(await page.$eval("#stop",el=>!el.disabled&&el.getClientRects().length>0),true);
    assert.match(await page.$eval("#status",el=>el.textContent),/再生中.*停止/,
      "Explain why the source region stays open during playback");
    await page.click("#stop");
    await page.waitForFunction(()=>document.querySelector("#stop").disabled);
    const beforeFolds={
      file:await page.$eval("#file-meta",el=>el.textContent),
      playable:await page.$eval("#play-wet",el=>!el.disabled),
      sourceF:await page.$eval("#vr-source-f",el=>el.value),
      slope:await page.$eval("#axis-slope",el=>el.value),
      graphLog:await page.$eval("#graph-log",el=>el.value),
      sine:await page.$eval("#sine-hz",el=>el.value),
      harmonicPlacement:await page.$eval("#rational-enabled",el=>el.checked)
    };
    for(const selector of ["#source-region","#virtual-root-workbench",
      ".quick-panel > .panel-fold",".workspace-right > .panel-fold",
      ".sine-monitor > .panel-fold"]){
      const summary=selector+" > summary";
      await page.click(summary);
      assert.equal(await page.$eval(selector,el=>el.open),false,
        "Each main work region must be individually collapsible: "+selector);
      await page.click(summary);
      assert.equal(await page.$eval(selector,el=>el.open),true,
        "Each main work region must be individually restorable: "+selector);
    }
    assert.deepEqual({
      file:await page.$eval("#file-meta",el=>el.textContent),
      playable:await page.$eval("#play-wet",el=>!el.disabled),
      sourceF:await page.$eval("#vr-source-f",el=>el.value),
      slope:await page.$eval("#axis-slope",el=>el.value),
      graphLog:await page.$eval("#graph-log",el=>el.value),
      sine:await page.$eval("#sine-hz",el=>el.value),
      harmonicPlacement:await page.$eval("#rational-enabled",el=>el.checked)
    },beforeFolds,"Collapsing and restoring regions must preserve loaded audio and control values");
    // #79 M3 exact single-source Wet: typed %, coarse range, A/B and reset.
    const setWet=percent=>page.$eval("#wet-value",(el,value)=>{
      el.value=value;el.dispatchEvent(new Event("input",{bubbles:true}));
    },String(percent));
    const canonicalWet=()=>page.$eval("#wet-value",el=>Number(el.dataset.fwCanonical));
    await setWet("12.345");
    assert.ok(Math.abs(await canonicalWet()-.12345)<1e-12,
      "typed 12.345% must not be quantized to the coarse slider step");
    assert.equal(await page.$eval("#wet-value",el=>el.value),"12.3");
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
    assert.equal(await page.$eval("#wet-value",el=>el.value),"12.3");
    assert.ok(Math.abs(await canonicalAReverb()-.75)<1e-12,
      "A-engine reverb is a shared Settings value; A/B must not restore its saved value");
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

    // Keep the one-second export fixture intact until the existing WAV checks
    // finish, then exercise A/B with real BufferSource offsets and Rust/WASM.
    await (await page.$("#audio-file")).uploadFile(transportWav);
    await page.waitForFunction(()=>document.querySelector("#file-meta").textContent.includes("transport.wav")&&
      !document.querySelector("#play-wet").disabled,{timeout:20000});
    const seekTo=seconds=>page.$eval("#wave",(wave,value)=>{
      const bounds=wave.getBoundingClientRect();
      wave.dispatchEvent(new PointerEvent("pointerdown",{bubbles:true,
        clientX:bounds.left+bounds.width*value/8,clientY:bounds.top+bounds.height/2}));
    },seconds);
    await page.click("#play-dry");
    await page.waitForFunction(()=>!document.querySelector("#stop").disabled&&
      document.querySelector("#rt-indicator").textContent.includes("原音再生中"),{timeout:12000});
    await seekTo(2.4);
    await page.click("#compare-save-a");
    const aOffset=await page.evaluate(()=>window.__comparisonSourceStarts.at(-1));
    await page.click("#stop");
    await page.waitForFunction(()=>document.querySelector("#stop").disabled);
    await seekTo(5.6);
    await page.click("#play-wet");
    await page.waitForFunction(()=>!document.querySelector("#stop").disabled&&
      document.querySelector("#rt-indicator").textContent.includes("稼働中"),{timeout:25000});
    await seekTo(5.6);
    await page.click("#compare-save-b");
    const bOffset=await page.evaluate(()=>window.__comparisonSourceStarts.at(-1));
    await page.click("#stop");
    await page.waitForFunction(()=>document.querySelector("#stop").disabled);

    await page.click("#compare-load-a");
    await page.waitForFunction(()=>!document.querySelector("#stop").disabled&&
      document.querySelector("#status").textContent.includes("原音再生中"),{timeout:12000});
    const restoredA=await page.evaluate(()=>window.__comparisonSourceStarts.at(-1));
    assert.ok(Math.abs(restoredA-aOffset)<.15,
      "A restores its saved original-audio mode and playhead");
    await page.click("#stop");
    await page.waitForFunction(()=>document.querySelector("#stop").disabled);
    await page.click("#compare-load-b");
    await page.waitForFunction(()=>!document.querySelector("#stop").disabled&&
      document.querySelector("#rt-indicator").textContent.includes("稼働中"),{timeout:25000});
    const restoredB=await page.evaluate(()=>window.__comparisonSourceStarts.at(-1));
    assert.ok(Math.abs(restoredB-bOffset)<.15,
      "B restores its saved Rust/WASM processed mode and playhead");
    await page.click("#stop");
    await page.waitForFunction(()=>document.querySelector("#stop").disabled);
    await page.evaluate(()=>{
      document.querySelector("#compare-load-a").click();
      document.querySelector("#compare-load-b").click();
    });
    await page.waitForFunction(()=>document.querySelector("#comparison-status").dataset.phase==="applied"&&
      document.querySelector("#comparison-status").textContent.includes("設定B")&&
      document.querySelector("#rt-indicator").textContent.includes("稼働中"),{timeout:25000});
    assert.ok(Math.abs(await page.evaluate(()=>window.__comparisonSourceStarts.at(-1))-bOffset)<.15,
      "rapid A→B selection leaves the latest slot's mode and playhead active");
    await page.click("#stop");
    await page.click("#runtime-hud-restore");
    const hudHead=await page.$eval("#runtime-hud-head",el=>{
      const r=el.getBoundingClientRect();return {x:r.left+20,y:r.top+r.height/2};
    });
    await page.mouse.move(hudHead.x,hudHead.y);
    await page.mouse.down();
    await page.mouse.move(hudHead.x+48,hudHead.y+42,{steps:3});
    await page.mouse.up();
    assert.equal(await page.$eval("#runtime-hud",el=>
      el.classList.contains("is-floating")&&getComputedStyle(el).position==="fixed"),true,
      "Dragging the inline status panel must preserve its floating-window behavior");
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


test("Pages entry: Stop keeps source reachable during AudioWorklet startup",async()=>{
  const root=await mkdtemp(join(tmpdir(),"warp-startup-race-"));
  const server=liveUrl?null:spawn("python3",["-m","http.server","8767","--bind","127.0.0.1"],{
    cwd:resolve(process.env.WARP_WEB_ROOT||"_site"),stdio:"ignore"
  });
  let browser;
  try{
    const wav=join(root,"startup.wav");await writeFile(wav,shortWav());
    browser=await puppeteer.launch({
      executablePath:process.env.CHROME_BIN||"/usr/bin/google-chrome",
      headless:true,
      args:["--no-sandbox","--disable-dev-shm-usage","--autoplay-policy=no-user-gesture-required"]
    });
    const page=await browser.newPage();
    await page.setViewport({width:390,height:844,deviceScaleFactor:2,isMobile:true,hasTouch:true});
    const errors=[];page.on("pageerror",error=>errors.push(String(error.message)));
    const url=liveUrl||"http://127.0.0.1:8767/index.html";
    await page.goto(url,{waitUntil:"domcontentloaded",timeout:20000});
    await page.waitForFunction(()=>document.documentElement.dataset.fwBoot==="ready",
      {timeout:15000});
    const audioFile=join(root,"startup.wav");
    await (await page.$("#audio-file")).uploadFile(audioFile);
    await page.waitForFunction(()=>!document.querySelector("#play-wet").disabled,
      {timeout:20000});
    await page.evaluate(()=>{
      const NativeContext=window.AudioContext;
      window.__raceNativeAudioContext=NativeContext;
      window.AudioContext=class extends NativeContext{
        createBufferSource(...args){
          const source=super.createBufferSource(...args);
          const start=source.start.bind(source);
          source.start=(...values)=>{
            window.__raceSourceStarted=true;
            return start(...values);
          };
          return source;
        }
      };
      const NativeWorklet=window.AudioWorkletNode;
      window.__raceNativeWorkletNode=NativeWorklet;
      window.AudioWorkletNode=class extends NativeWorklet{
        constructor(...args){
          super(...args);
          this.port.addEventListener("message",event=>{
            if(event.data?.type==="ready")window.__raceLateReady=true;
          });
          const send=this.port.postMessage.bind(this.port);
          this.port.postMessage=(message,...rest)=>{
            if(message?.type==="init"){
              window.__raceReleaseWorkletInit=()=>send(message,...rest);
              return;
            }
            return send(message,...rest);
          };
        }
      };
    });
    await page.click("#play-wet");
    await page.waitForFunction(()=>typeof window.__raceReleaseWorkletInit==="function",
      {timeout:20000});
    assert.equal(await page.evaluate(()=>window.__raceSourceStarted),true,
      "The regression window must occur after the source is scheduled but before Worklet readiness");
    assert.equal(await page.$eval("#stop",element=>element.disabled),false,
      "Stop must become available as soon as playback startup begins");
    await page.click("#source-region > summary");
    assert.equal(await page.$eval("#source-region",element=>element.open),true,
      "The source region must remain open while its AudioWorklet is initializing");
    assert.match(await page.$eval("#status",element=>element.textContent),/再生中.*停止/,
      "Explain why the source region stays open during Worklet startup");
    await page.click("#stop");
    await page.waitForFunction(()=>document.querySelector("#stop").disabled);
    assert.equal(await page.$eval("#play-wet",element=>element.disabled),false,
      "Stopping a pending Worklet launch must restore the playback controls");
    await page.evaluate(()=>{
      window.__raceReleaseWorkletInit?.();
      window.AudioWorkletNode=window.__raceNativeWorkletNode;
      window.AudioContext=window.__raceNativeAudioContext;
    });
    await page.waitForFunction(()=>window.__raceLateReady===true,{timeout:15000});
    assert.equal(await page.$eval("#stop",element=>element.disabled),true,
      "A canceled Worklet launch must not restart playback when init finishes");
    assert.equal(await page.$eval("#play-wet",element=>element.disabled),false,
      "A late ready acknowledgement must not leave playback controls disabled");
    assert.match(await page.$eval("#rt-indicator",element=>element.textContent),/停止中/,
      "A late Worklet ready acknowledgement must leave transport stopped");
    assert.deepEqual(errors,[],"The startup cancellation must not cause a browser error");
  }finally{
    if(browser)await browser.close();
    if(server){server.kill();await new Promise(resolve=>server.once("exit",resolve));}
    await rm(root,{recursive:true,force:true});
  }
});

test("Pages entry: 768px touch layout keeps transform controls beside the graph",async()=>{
  const server=liveUrl?null:spawn("python3",["-m","http.server","8768","--bind","127.0.0.1"],{
    cwd:resolve(process.env.WARP_WEB_ROOT||"_site"),stdio:"ignore"
  });
  let browser;
  try{
    browser=await puppeteer.launch({
      executablePath:process.env.CHROME_BIN||"/usr/bin/google-chrome",
      headless:true,args:["--no-sandbox","--disable-dev-shm-usage"]
    });
    const page=await browser.newPage();
    await page.setViewport({width:768,height:844,deviceScaleFactor:2,isMobile:true,hasTouch:true});
    const url=liveUrl||"http://127.0.0.1:8768/index.html";
    let loaded=false,lastError="";
    for(let attempt=0;attempt<8&&!loaded;attempt++){
      try{
        await page.goto(url,{waitUntil:"domcontentloaded",timeout:15000});
        await page.waitForFunction(()=>document.documentElement.dataset.fwBoot==="ready"&&
          document.querySelector("#vr-summary")?.textContent.includes("仮想基音"),{timeout:12000});
        loaded=true;
      }catch(error){
        lastError=error.message;
        await new Promise(resolve=>setTimeout(resolve,800));
      }
    }
    assert.ok(loaded,"768px touch entry must boot: "+lastError);
    const coView=await page.evaluate(()=>{
      const rail=document.querySelector("#axis-slope");
      rail.scrollIntoView({block:"center",inline:"nearest"});
      const rect=selector=>document.querySelector(selector).getBoundingClientRect();
      const r=rect("#axis-slope"),g=rect("#curve"),graph=rect(".workspace-right"),controls=rect(".quick-panel");
      const overlap=(a,b)=>!(a.right<=b.left||b.right<=a.left||a.bottom<=b.top||b.bottom<=a.top);
      return {railVisible:r.top>=0&&r.bottom<=innerHeight,graphVisible:g.top>=0&&g.bottom<=innerHeight,
        railGraphOverlap:overlap(r,g),railPanelOverlap:overlap(r,graph),
        columns:controls.right<=graph.left||graph.right<=controls.left,
        graphWidth:g.width,graphHeight:g.height,overflow:document.documentElement.scrollWidth>innerWidth};
    });
    assert.ok(coView.railVisible&&coView.graphVisible&&!coView.railGraphOverlap&&!coView.railPanelOverlap&&
      coView.columns&&coView.graphWidth>=145&&Math.abs(coView.graphWidth-coView.graphHeight)<2&&!coView.overflow,
      "768px touch transform rail and graph must be reachable side-by-side: "+JSON.stringify(coView));
    const before=await page.$eval("#axis-slope",el=>el.value);
    const bounds=await page.$eval("#axis-slope",el=>{const r=el.getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height};});
    await page.mouse.click(bounds.x+bounds.w*.1,bounds.y+bounds.h/2);
    assert.notEqual(await page.$eval("#axis-slope",el=>el.value),before,
      "The 768px transform rail must remain operable with the graph visible");

    const assertInlineEffectHelp=async(width)=>{
      await page.setViewport({width,height:844,deviceScaleFactor:2,
        isMobile:width<=600,hasTouch:width<=800});
      const rows=await page.evaluate(()=>({
        width:innerWidth,
        items:["ring-enabled","crusher-enabled"].map(id=>{
          const input=document.querySelector("#"+id),item=input.closest(".fx-item");
          const label=input.closest(".fx-toggle"),tip=item.querySelector(".info-tip");
          const a=label.getBoundingClientRect(),b=tip.getBoundingClientRect();
          return {id,sharedRow:Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top)>0,
            iconRight:b.right};
        })
      }));
      assert.ok(rows.items.every(x=>x.sharedRow&&x.iconRight<=rows.width+1),
        "Ring/BitCrusher ⓘ must stay beside its label without leaving the viewport: "+JSON.stringify(rows));
    };
    for(const width of [320,390]){
      await page.setViewport({width,height:844,deviceScaleFactor:2,isMobile:true,hasTouch:true});
      await page.goto(url,{waitUntil:"domcontentloaded"});
      await page.waitForFunction(()=>document.documentElement.dataset.fwBoot==="ready",{timeout:15000});
      for(const label of ["傾きの説明","変換範囲の説明","グラフ表示の説明",
        "リング変調の説明","ビットクラッシャーの説明"]){
        const summarySelector=`details.info-tip > summary[aria-label="${label}"]`;
        const point=await page.$eval(summarySelector,summary=>{
          summary.scrollIntoView({block:"center",inline:"nearest"});
          const r=summary.getBoundingClientRect();
          return {x:r.x+r.width/2,y:r.y+r.height/2};
        });
        await page.touchscreen.tap(point.x,point.y);
        const opened=await page.$eval(summarySelector,summary=>summary.parentElement.open);
        assert.ok(opened,`${label} must open from a mobile touch`);
        const popup=await page.$eval(summarySelector,summary=>{
          const body=summary.parentElement.querySelector(".info-body");
          const r=body.getBoundingClientRect();
          return {left:r.left,right:r.right,width:innerWidth,
            visible:getComputedStyle(body).display!=="none",
            text:body.innerText.trim()};
        });
        assert.ok(popup.visible&&popup.text&&popup.left>=-1&&popup.right<=width+1,
          `${label} must open fully inside the ${width}px viewport: ${JSON.stringify(popup)}`);
        await page.touchscreen.tap(point.x,point.y);
        const closed=await page.$eval(summarySelector,summary=>!summary.parentElement.open);
        assert.ok(closed,`${label} must close again from a mobile touch`);
      }
    }
    await assertInlineEffectHelp(1280);
    await assertInlineEffectHelp(390);

    await page.evaluate(()=>{
      window.__crusherPreviewLabels=[];
      const draw=CanvasRenderingContext2D.prototype.fillText;
      CanvasRenderingContext2D.prototype.fillText=function(text,...args){
        if(this.canvas?.id==="crusher-preview")window.__crusherPreviewLabels.push(String(text));
        return draw.call(this,text,...args);
      };
    });
    await page.click("#crusher-enabled");
    await page.waitForFunction(()=>!document.querySelector("#fx-wave-preview").hidden);
    const figure=await page.$eval("#crusher-preview",el=>({
      label:el.getAttribute("aria-label"),
      caption:document.querySelector("#fx-wave-caption").textContent
    }));
    assert.match(figure.label,/横軸.*サンプル/);
    assert.match(figure.label,/縦軸.*振幅/);
    assert.match(figure.label,/原音.*加工後/);
    assert.match(figure.label,/保持.*量子化/);
    assert.match(figure.caption,/合成モデル.*実測ではありません/);
    const drawnLabels=await page.evaluate(()=>window.__crusherPreviewLabels);
    for(const expected of ["振幅（正規化）","サンプル","原音","加工後","保持/量子化"]){
      assert.ok(drawnLabels.includes(expected),
        "Chrome must draw the label into the actual waveform canvas: "+expected);
    }
  }finally{
    await browser?.close();
    server?.kill("SIGTERM");
  }
});


test("Public entry shows a source-local error when audio module never boots",{
  timeout:45000
},async()=>{
  const server=liveUrl?null:spawn("python3",["-m","http.server","8767","--bind","127.0.0.1"],{
    cwd:resolve(process.env.WARP_WEB_ROOT||"_site"),stdio:"ignore"
  });
  let browser;
  try{
    browser=await puppeteer.launch({
      executablePath:process.env.CHROME_BIN||"/usr/bin/google-chrome",
      headless:true,args:["--no-sandbox","--disable-dev-shm-usage"]
    });
    const page=await browser.newPage();
    await page.setViewport({width:390,height:844,deviceScaleFactor:2,isMobile:true,hasTouch:true});
    await page.setRequestInterception(true);
    page.on("request",request=>{
      if(new URL(request.url()).pathname.endsWith("/app.mjs"))
        request.abort("failed");
      else request.continue();
    });
    await page.goto(liveUrl||"http://127.0.0.1:8767/index.html",{
      waitUntil:"domcontentloaded",timeout:18000
    });
    await page.waitForFunction(()=>
      document.querySelector("#file-meta").textContent.includes("音声処理を起動できませんでした"),
      {timeout:12000});
    assert.match(await page.$eval("#status",el=>el.textContent),/起動に失敗/);
    assert.equal(await page.$eval("#status",el=>el.dataset.kind),"error");
    assert.match(await page.$eval("#file-meta",el=>el.textContent),/再読込み/,
      "On narrow screens the actionable failure must appear beside native source chooser");
    await page.close();
  }finally{
    await browser?.close();
    server?.kill("SIGTERM");
  }
});
