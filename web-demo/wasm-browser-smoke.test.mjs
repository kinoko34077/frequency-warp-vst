import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,writeFile,rm} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {spawn} from "node:child_process";
import puppeteer from "puppeteer-core";

function sineWav(seconds=12) {
  const rate=16000,samples=rate*seconds,wav=Buffer.alloc(44+samples*2);
  wav.write("RIFF",0);wav.writeUInt32LE(wav.length-8,4);
  wav.write("WAVE",8);wav.write("fmt ",12);wav.writeUInt32LE(16,16);
  wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);
  wav.writeUInt32LE(rate,24);wav.writeUInt32LE(rate*2,28);
  wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);
  wav.write("data",36);wav.writeUInt32LE(samples*2,40);
  for(let i=0;i<samples;i++)wav.writeInt16LE(
    Math.round(14000*Math.cos(2*Math.PI*900*i/rate)),44+i*2);
  return wav;
}
test("Chrome real-time Rust AudioWorklet streams, changes controls, seeks at waveform click",async()=>{
  const temp=await mkdtemp(path.join(os.tmpdir(),"warp-realtime-"));
  const server=spawn("python3",["-m","http.server","8765","--bind","127.0.0.1"],
    {cwd:path.resolve("web-demo"),stdio:"ignore"});
  let browser;
  try{
    const wavPath=path.join(temp,"twelve.wav");await writeFile(wavPath,sineWav());
    browser=await puppeteer.launch({
      executablePath:process.env.CHROME_BIN||"/usr/bin/google-chrome",
      headless:true,
      args:["--no-sandbox","--disable-dev-shm-usage","--autoplay-policy=no-user-gesture-required"]
    });
    const page=await browser.newPage();
    const errors=[];
    page.on("pageerror",e=>errors.push(e.message));
    let okay=false;
    for(let i=0;i<36;i++){
      try{
        const resp=await page.goto("http://127.0.0.1:8765/index.html");
        if(resp?.ok()){okay=true;break;}
      }catch{}
      await new Promise(r=>setTimeout(r,250));
    }
    assert.ok(okay,"page not served");
    await page.waitForFunction(()=>document.querySelector("#curve").width===document.querySelector("#curve").height&&
      document.querySelector("#math-results")?.textContent.includes("仮想格子"),{timeout:16000})
      .catch(async err=>{throw Error("UI boot failed: "+JSON.stringify(await page.evaluate(()=>({
        math:document.querySelector("#math-results")?.textContent,curve:[
          document.querySelector("#curve").width,document.querySelector("#curve").height],
        errors:window.__uiErrors||[]
      })))+" | "+err.message);});
    const dimensions=await page.$eval("#curve",el=>({w:el.width,h:el.height}));
    assert.equal(dimensions.w,dimensions.h,"20-2kHz mapping must be square");
    assert.equal(await page.$eval("#invert",el=>el.value),"0","neutral mapping is the only default that allows ordinary pitch shift");
    assert.equal(await page.$eval("#axis-shift",el=>el.step),"0.05");
    await page.$eval("#curvature",el=>{el.value="0";el.dispatchEvent(new Event("input",{bubbles:true}));});
    await page.$eval("#axis-shift",el=>{el.value=".7";el.dispatchEvent(new Event("input",{bubbles:true}));});
    assert.match(await page.$eval("#axis-explainer",el=>el.textContent),/対数移動: ×2/);
    assert.doesNotMatch(await page.$eval("#math-axis-note",el=>el.textContent),/準備中|未算出|計算中/);
    assert.match(await page.$eval("#math-axis-note",el=>el.textContent),/上下移動後/);
    await page.click("#axis-zero");
    assert.equal(await page.$eval("#axis-shift",el=>Number(el.value)),0);
    assert.match(await page.$eval("#axis-shift-value",el=>el.textContent),/0\.000/);
    await page.$eval("#curvature",el=>{el.value="1";el.dispatchEvent(new Event("input",{bubbles:true}));});

    assert.match(await page.$eval("#math-results",el=>el.textContent),/H=F′\/m=87.5 Hz/);
    // Independent sine test can run before an audio file has been loaded.
    assert.equal(await page.$eval("#sine-hz",el=>el.textContent),"440.00 Hz");
    await page.click("#sine-enabled");
    assert.equal(await page.$eval("#sine-enabled",el=>el.checked),true);
    await page.$eval("#sine-pitch",el=>{el.value="69.5";el.dispatchEvent(new Event("input",{bubbles:true}));});
    assert.match(await page.$eval("#sine-hz",el=>el.textContent),/452\.89 Hz/);
    assert.match(await page.$eval("#sine-cent",el=>el.textContent),/-50 cent|\+50 cent/);
    await page.click("#sine-enabled");
    await page.$eval("#axis-shift",el=>{el.value=".25";el.dispatchEvent(new Event("input",{bubbles:true}));});
    assert.match(await page.$eval("#axis-explainer",el=>el.textContent),/Hz/);
    assert.match(await page.$eval("#mini-fundamental",el=>el.textContent),/→/);
    await page.click("#tab-math");
    assert.equal(await page.$eval("#view-math",el=>el.hidden),false);
    await page.$eval("#numerator-range",el=>{
      el.value="-3";el.dispatchEvent(new Event("input",{bubbles:true}));
    });
    assert.equal(await page.$eval("#numerator",el=>el.value),"-3");
    assert.match(await page.$eval("#math-results",el=>el.textContent),/Δ = \(n\/m\)F′ = -262.5 Hz/);
    await page.$eval("#carrier-range",el=>{el.value="1000";el.dispatchEvent(new Event("input",{bubbles:true}));});
    assert.equal(await page.$eval("#carrier",el=>Number(el.value)),20000);
    await page.$eval("#carrier-range",el=>{el.value="0";el.dispatchEvent(new Event("input",{bubbles:true}));});
    assert.equal(await page.$eval("#carrier",el=>Number(el.value)),0);
    await page.$eval("#carrier-range",el=>{el.value="592";el.dispatchEvent(new Event("input",{bubbles:true}));});
    await page.click("#carrier-link");
    await page.waitForFunction(()=>document.querySelector("#carrier-linked-value").textContent.includes("Hz") &&
      document.querySelector("#carrier").disabled,{timeout:10000});
    const linked1=await page.$eval("#carrier-linked-value",el=>el.textContent);
    await page.$eval("#invert",el=>{el.value=".45";el.dispatchEvent(new Event("input",{bubbles:true}));});
    const linked2=await page.$eval("#carrier-linked-value",el=>el.textContent);
    assert.notEqual(linked1,linked2,"Fold location must change with invert parameter");
    await page.click("#tab-map");
    assert.equal(await page.$eval("#view-map",el=>el.hidden),false);
    await page.click("#settings-open");
    assert.equal(await page.$eval("#settings-dialog",el=>el.open),true);

    // Instrument old offline Worker: any attempt while clicking play would be a regression.
    await page.evaluate(()=>{
      window.offlineWorkersCreated=0;
      const NativeWorker=window.Worker;
      window.Worker=function(...args){
        window.offlineWorkersCreated++;
        return new NativeWorker(...args);
      };
    });
    await page.select("#quality","eco");
    await page.click("#settings-done");
    await (await page.$("#audio-file")).uploadFile(wavPath);
    await page.waitForFunction(()=>!document.querySelector("#play-wet").disabled,{timeout:20000});
    const metadata=await page.$eval("#file-meta",n=>n.textContent);
    assert.match(metadata,/12\.0秒/);
    assert.equal(await page.$eval("#stop",n=>n.disabled),true);
    await page.click("#play-wet");
    try{
      await page.waitForFunction(()=>document.querySelector("#rt-indicator").textContent.includes("稼働中")&&
        !document.querySelector("#stop").disabled,{timeout:25000});
    }catch(e){
      const snapshot=await page.evaluate(()=>({
        status:document.querySelector("#status").textContent,
        indicator:document.querySelector("#rt-indicator").textContent,
        buttons:[document.querySelector("#play-wet").disabled,document.querySelector("#stop").disabled],
        diag:window.__warpDebug?.()
      }));
      throw Error("AudioWorklet startup: "+JSON.stringify(snapshot)+"; page errors: "+errors.join("; ")+"; "+e.message);
    }
    const before=await page.$eval("#elapsed",n=>n.textContent);
    await page.$eval("#invert",node=>{
      node.value=".42";node.dispatchEvent(new Event("input",{bubbles:true}));
    });
    await page.waitForFunction(()=>document.querySelector("#rt-indicator").textContent.includes("操作反映済み"),
      {timeout:15000});
    // Switch actual Rust DSP engines via the discoverable SETTINGS dialog.
    await page.click("#settings-open");
    // Ring and rational layout are *effects*, not synthesis engines.
    assert.deepEqual(await page.evaluate(()=>Array.from(document.querySelectorAll("#engine option:not(:disabled)")).map(n=>n.value)),["0","1"]);
    await page.click("#ring-enabled");
    assert.match(await page.$eval("#engine-description",el=>el.textContent),/Ring Mod/);
    await page.click("#rational-enabled");
    await page.waitForFunction(()=>document.querySelector("#rt-indicator").textContent.includes("操作反映済み"),{timeout:25000});
    await page.select("#engine","1");
    await page.waitForFunction(()=>document.querySelector("#rt-indicator").textContent.includes("稼働中"),{timeout:25000});
    await page.select("#engine","0");
    await page.waitForFunction(()=>document.querySelector("#rt-indicator").textContent.includes("稼働中"),{timeout:25000});
    await page.select("#overlap","8");
    await page.waitForFunction(()=>document.querySelector("#rt-indicator").textContent.includes("稼働中"),{timeout:25000});
    await page.select("#mode","fold-l");
    await page.select("#outside","kill");
    await page.click("#settings-done");
    assert.equal(await page.$eval("#settings-dialog",el=>el.open),false);
    await page.$eval("#low",n=>{n.value="250";n.dispatchEvent(new Event("input",{bubbles:true}));});
    assert.equal(await page.$eval("#stop",n=>n.disabled),false);
    const canvas=await page.$("#wave");
    const rect=await canvas.boundingBox();
    assert.ok(rect?.width>100);
    await page.mouse.click(rect.x+rect.width*.62,rect.y+rect.height/2);
    await page.waitForFunction(()=>parseFloat(document.querySelector("#elapsed").textContent.split(":")[1])>6,
      {timeout:10000});
    const cursor=await page.$eval("#playhead",n=>parseFloat(n.style.left));
    assert.ok(cursor>50&&cursor<76,"seek playhead "+cursor);
    assert.equal(await page.$eval("#stop",n=>n.disabled),false);
    assert.equal(await page.evaluate(()=>window.offlineWorkersCreated),0,
      "whole-track offline Worker created during real-time playback");
    assert.deepEqual(errors,[]);
    await page.click("#stop");
    assert.equal(await page.$eval("#stop",n=>n.disabled),true);
    // Check mobile layout without overriding current application state.
    await page.setViewport({width:390,height:844,deviceScaleFactor:1});
    await page.waitForFunction(()=>document.querySelector("#curve").width===document.querySelector("#curve").height);
    const layout=await page.evaluate(()=>({
      overflow:document.documentElement.scrollWidth-document.documentElement.clientWidth,
      settingsRect:((r)=>({x:r.x,width:r.width,right:r.right}))(document.querySelector("#settings-open").getBoundingClientRect()),
      curve:((r)=>({x:r.x,width:r.width,right:r.right}))(document.querySelector("#curve").getBoundingClientRect()),
      leftPanel:((r)=>({x:r.x,width:r.width,right:r.right,top:r.top}))(document.querySelector(".quick-panel").getBoundingClientRect()),
      rightPanel:((r)=>({x:r.x,width:r.width,right:r.right,top:r.top}))(document.querySelector(".workspace-right").getBoundingClientRect()),

      viewHidden:document.querySelector("#view-map").hidden,
      tabState:document.querySelector("#tab-map").getAttribute("aria-selected"),
      canvasSize:[document.querySelector("#curve").width,document.querySelector("#curve").height]
    }));
    assert.ok(layout.overflow<=2,"Mobile horizontal overflow "+layout.overflow);
    assert.ok(layout.curve.width>115,"Mobile graph should fit in right column "+JSON.stringify(layout));
    assert.ok(layout.leftPanel.right<=layout.rightPanel.x+3,"Controls must be LEFT of graph "+JSON.stringify(layout));
    assert.ok(Math.abs(layout.leftPanel.top-layout.rightPanel.top)<12,"Controls and graph must SHARE ROW "+JSON.stringify(layout));
    assert.ok(layout.settingsRect.right<=390);
    assert.ok(layout.curve.width<=210,"Mobile graph should use freed space for sliders "+JSON.stringify(layout));
    assert.equal(await page.$eval("#view-map",el=>el.hidden),false);
    assert.match(await page.$eval("#mini-harmonics",el=>el.textContent),/第3倍音/);
    await page.click("#settings-open");
    await page.select("#harmonic-count","12");
    await page.click("#crusher-enabled");
    await page.$eval("#crusher-bits",el=>{el.value="3";el.dispatchEvent(new Event("input",{bubbles:true}));});
    assert.equal(await page.$eval("#crusher-bits-value",el=>el.textContent),"3 bit");
    await page.click("#settings-done");
    await page.click("#mini-expand");
    assert.equal(await page.$eval("#view-map",el=>el.hidden),false,"graph must stay visible when equations open");
    assert.match(await page.$eval("#harmonic-table-title",el=>el.textContent),/12倍音/);
    const harmonics=await page.$eval("#harmonics-body",el=>el.children.length);
    assert.equal(harmonics,12);
    await page.click("#tab-map");

    // Check a 601s source is trimmed to 600s without rendering the track.
    const longPath=path.join(temp,"six-hundred.wav");
    await writeFile(longPath,sineWav(601));
    await (await page.$("#audio-file")).uploadFile(longPath);
    await page.waitForFunction(()=>document.querySelector("#file-meta").textContent.includes("600.0秒"),{timeout:45000});
    assert.equal(await page.$eval("#duration",el=>el.textContent),"10:00.0");
    await page.$eval("#wave",el=>el.scrollIntoView({block:"center",behavior:"instant"}));
    const longWave=await (await page.$("#wave")).boundingBox();
    await page.mouse.click(longWave.x+longWave.width*.9,longWave.y+longWave.height/2);
    await page.waitForFunction(()=>!document.querySelector("#stop").disabled,{timeout:25000})
      .catch(async err=>{
        const state=await page.evaluate(()=>({
          status:document.querySelector("#status").textContent,
          indicator:document.querySelector("#rt-indicator").textContent,
          current:document.querySelector("#elapsed").textContent,
          selected:document.querySelector("#engine").value,
          crash:document.querySelector("#play-wet").disabled,
          errors:[]
        }));
        throw Error("600-second start: "+JSON.stringify(state)+" | "+err.message);
      });
    const minute=await page.$eval("#elapsed",el=>Number(el.textContent.split(":")[0]));
    assert.equal(minute,9,"600s seek failed");
    await page.click("#stop");
    await page.close();
  }finally{
    if(browser)await browser.close();
    server.kill("SIGTERM");
    await rm(temp,{recursive:true,force:true});
  }
});
