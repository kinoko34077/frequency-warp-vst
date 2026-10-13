import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,writeFile,rm} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {spawn} from "node:child_process";
import puppeteer from "puppeteer-core";

function toneWav(seconds=12) {
  const sampleRate=16000,samples=sampleRate*seconds;
  const wav=Buffer.alloc(44+samples*2);
  wav.write("RIFF",0);wav.writeUInt32LE(wav.length-8,4);
  wav.write("WAVE",8);wav.write("fmt ",12);
  wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);
  wav.writeUInt16LE(1,22);wav.writeUInt32LE(sampleRate,24);
  wav.writeUInt32LE(sampleRate*2,28);wav.writeUInt16LE(2,32);
  wav.writeUInt16LE(16,34);wav.write("data",36);
  wav.writeUInt32LE(samples*2,40);
  for(let i=0;i<samples;i++)
    wav.writeInt16LE(Math.round(14000*Math.cos(2*Math.PI*900*i/sampleRate)),44+2*i);
  return wav;
}

test("Pages-style browser serves Rust wasm and converts >10sec audio",async ()=>{
  const temp=await mkdtemp(path.join(os.tmpdir(),"warp-wasm-"));
  let browser;
  const server=spawn("python3",["-m","http.server","8765","--bind","127.0.0.1"],
    {cwd:path.resolve("web-demo"),stdio:"ignore"});
  try {
    const wavPath=path.join(temp,"twelve-seconds.wav");
    await writeFile(wavPath,toneWav(12));
    browser=await puppeteer.launch({
      executablePath:process.env.CHROME_BIN||"/usr/bin/google-chrome",
      headless:true,
      args:["--no-sandbox","--disable-dev-shm-usage","--autoplay-policy=no-user-gesture-required"]
    });
    const page=await browser.newPage();
    const errors=[];
    page.on("pageerror",e=>errors.push(e.message));
    let ready=false;
    for(let i=0;i<30;i++){
      try{
        const response=await page.goto("http://127.0.0.1:8765/index.html");
        if(response?.ok()){ready=true;break;}
      }catch{}
      await new Promise(r=>setTimeout(r,250));
    }
    assert.ok(ready,"local preview server did not start");
    await page.select("#quality","eco");
    await (await page.$("#audio-file")).uploadFile(wavPath);
    await page.waitForFunction(()=>!document.querySelector("#render").disabled,{timeout:20000});
    const metadata=await page.$eval("#file-meta",e=>e.textContent);
    assert.ok(metadata.includes("12.00"),"audio unexpectedly truncated before 10s: "+metadata);
    await page.click("#render");
    await page.waitForFunction(()=>!document.querySelector("#play-wet").disabled,{timeout:120000});
    assert.equal(await page.$eval("#progress",e=>e.value),100);
    assert.equal(await page.$eval("#download",e=>e.disabled),false);
    const status=await page.$eval("#status",e=>e.textContent);
    assert.match(status,/共通Rust\/WASMエンジンで変換完了/);
    assert.deepEqual(errors,[]);
    await page.close();
  } finally {
    if(browser)await browser.close();
    server.kill("SIGTERM");
    await rm(temp,{recursive:true,force:true});
  }
});
