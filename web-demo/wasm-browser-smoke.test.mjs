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
      document.querySelector("#math-results")?.textContent.includes("仮想基音"),{timeout:16000})
      .catch(async err=>{throw Error("UI boot failed: "+JSON.stringify(await page.evaluate(()=>({
        math:document.querySelector("#math-results")?.textContent,curve:[
          document.querySelector("#curve").width,document.querySelector("#curve").height],
        errors:window.__uiErrors||[]
      })))+" | "+err.message);});
    const dimensions=await page.$eval("#curve",el=>({w:el.width,h:el.height}));
    assert.equal(dimensions.w,dimensions.h,"20-2kHz mapping must be square");
    assert.match(await page.$eval("#math-results",el=>el.textContent),/H = F \/ m = 87.5 Hz/);
    await page.click("#tab-math");
    assert.equal(await page.$eval("#view-math",el=>el.hidden),false);
    await page.$eval("#numerator-range",el=>{
      el.value="-3";el.dispatchEvent(new Event("input",{bubbles:true}));
    });
    assert.equal(await page.$eval("#numerator",el=>el.value),"-3");
    assert.match(await page.$eval("#math-results",el=>el.textContent),/Δ = \(n\/m\)F = -262.5 Hz/);
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
    await page.select("#engine","2");
    await page.waitForFunction(()=>document.querySelector("#rt-indicator").textContent.includes("稼働中"),{timeout:25000});
    assert.match(await page.$eval("#engine-description",el=>el.textContent),/Ring Mod/);
    await page.select("#engine","3");
    await page.waitForFunction(()=>document.querySelector("#rt-indicator").textContent.includes("稼働中"),{timeout:25000});
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
      settingsRect:document.querySelector("#settings-open").getBoundingClientRect(),
      curve:document.querySelector("#curve").getBoundingClientRect()
    }));
    assert.ok(layout.overflow<=2,"Mobile horizontal overflow "+layout.overflow);
    assert.ok(layout.curve.width>200);
    assert.ok(layout.settingsRect.right<=390);
    await page.close();
  }finally{
    if(browser)await browser.close();
    server.kill("SIGTERM");
    await rm(temp,{recursive:true,force:true});
  }
});
