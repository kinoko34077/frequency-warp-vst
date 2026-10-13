import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,writeFile,rm,readFile} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {pathToFileURL,fileURLToPath} from "node:url";
import puppeteer from "puppeteer-core";

function sineWave() {
  const sampleRate=48000, samples=12000;
  const wav=Buffer.alloc(44+samples*2);
  wav.write("RIFF",0);wav.writeUInt32LE(wav.length-8,4);
  wav.write("WAVE",8);wav.write("fmt ",12);
  wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);
  wav.writeUInt16LE(1,22);wav.writeUInt32LE(sampleRate,24);
  wav.writeUInt32LE(sampleRate*2,28);wav.writeUInt16LE(2,32);
  wav.writeUInt16LE(16,34);wav.write("data",36);
  wav.writeUInt32LE(samples*2,40);
  for(let i=0;i<samples;i++){
    wav.writeInt16LE(Math.round(16000*Math.cos(2*Math.PI*900*i/sampleRate)),44+2*i);
  }
  return wav;
}

test("standalone file:// opens, decodes audio and computes genuine DSP output",async t=>{
  const temp=await mkdtemp(path.join(os.tmpdir(),"warp-preview-"));
  let browser;
  try{
    const wavPath=path.join(temp,"test.wav");await writeFile(wavPath,sineWave());
    const html=path.resolve("web-demo/standalone.html");
    const data=await readFile(html,"utf-8");
    assert.ok(data.includes("WORKER_SOURCE="));
    browser=await puppeteer.launch({
      executablePath:process.env.CHROME_BIN||"/usr/bin/google-chrome",
      headless:true,
      args:["--no-sandbox","--disable-dev-shm-usage","--autoplay-policy=no-user-gesture-required"]
    });
    const page=await browser.newPage();
    const errors=[];
    page.on("pageerror",e=>errors.push(e.message));
    await page.goto(pathToFileURL(html).href);
    await page.select("#quality","eco");
    await (await page.$("#audio-file")).uploadFile(wavPath);
    await page.waitForFunction(()=>!document.querySelector("#render").disabled,{timeout:12000});
    await page.click("#render");
    await page.waitForFunction(()=>!document.querySelector("#play-wet").disabled,
      {timeout:45000});
    assert.equal(await page.$eval("#progress",node=>node.value),100);
    assert.equal(await page.$eval("#download",node=>node.disabled),false);
    const result=await page.$eval("#status",node=>node.textContent);
    assert.match(result,/変換完了/);
    assert.deepEqual(errors,[]);
    await page.close();
  } finally {
    if(browser)await browser.close();
    await rm(temp,{recursive:true,force:true});
  }
});
