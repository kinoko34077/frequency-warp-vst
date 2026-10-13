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
    await (await page.$("#audio-file")).uploadFile(wavPath);
    await page.waitForFunction(()=>!document.querySelector("#play-wet").disabled,{timeout:20000});
    const metadata=await page.$eval("#file-meta",n=>n.textContent);
    assert.match(metadata,/12\.0秒/);
    assert.equal(await page.$eval("#stop",n=>n.disabled),true);
    await page.click("#play-wet");
    await page.waitForFunction(()=>document.querySelector("#rt-indicator").textContent.includes("稼働中")&&
      !document.querySelector("#stop").disabled,{timeout:25000});
    const before=await page.$eval("#elapsed",n=>n.textContent);
    await page.$eval("#invert",node=>{
      node.value=".42";node.dispatchEvent(new Event("input",{bubbles:true}));
    });
    await page.waitForFunction(()=>document.querySelector("#rt-indicator").textContent.includes("操作反映済み"),
      {timeout:15000});
    await page.select("#mode","fold-l");
    await page.select("#outside","kill");
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
    await page.close();
  }finally{
    if(browser)await browser.close();
    server.kill("SIGTERM");
    await rm(temp,{recursive:true,force:true});
  }
});
