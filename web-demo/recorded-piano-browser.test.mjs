/** #309: existing rights-cleared recording through the actual staged Web entry.
 * This is one recorded mono piano case, not perceptual or stereo acceptance. */
import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,readFile,rm,rename} from "node:fs/promises";
import {createHash} from "node:crypto";
import {spawn} from "node:child_process";
import {resolve,join} from "node:path";
import {tmpdir} from "node:os";
import {fileURLToPath} from "node:url";
import puppeteer from "puppeteer-core";
import {openPcmWavSource} from "./pcm-wav-source.mjs";

const filename="meta-piano-a0-cc0-3s-48khz.wav";
const sourcePath=fileURLToPath(new URL("./test-fixtures/"+filename,import.meta.url));
const delay=ms=>new Promise(done=>setTimeout(done,ms));
async function samples(bytes){
  const source=await openPcmWavSource(new Blob([bytes]));
  const info=source.info;
  assert.equal(info.channels,1);
  assert.equal(info.sampleRate,48000);
  assert.equal(info.frames,144000);
  assert.equal(info.bitsPerSample,16);
  const signal=new Float32Array(info.frames);
  for(let offset=0;offset<info.frames;offset+=8192){
    const [part]=await source.readFrames(offset,Math.min(8192,info.frames-offset));
    signal.set(part,offset);
  }
  return signal;
}
function measure(signal,reference){
  let energy=0,diff=0,peak=0;
  for(let i=0;i<signal.length;i++){
    const value=signal[i];
    assert.ok(Number.isFinite(value));
    energy+=value*value;
    peak=Math.max(peak,Math.abs(value));
    if(reference)diff+=(value-reference[i])**2;
  }
  return {rms:Math.sqrt(energy/signal.length),peak,
    differenceRms:Math.sqrt(diff/signal.length)};
}
async function downloadedBytes(path){
  for(let n=0;n<150;n++){
    try{return await readFile(path);}
    catch(error){if(error.code!=="ENOENT")throw error;}
    await delay(200);
  }
  throw Error("Actual browser WAV download did not complete: "+path);
}

test("#309 recorded CC0 piano: upload, native Wet playback, seek, A/B ACK and actual PCM16 download",{
  timeout:150000
},async()=>{
  const originalBytes=await readFile(sourcePath);
  assert.equal(createHash("sha256").update(originalBytes).digest("hex"),
    "69bbdab7ee718e174a23850f5525ff87761ca904a4445e6ae9138ca42b7dd261",
    "Use the exact licensed recorded fixture, not a generated tone");
  const original=await samples(originalBytes),input=measure(original);
  assert.ok(input.rms>1e-4,"recorded input must contain signal");

  const temp=await mkdtemp(join(tmpdir(),"warp-recorded-309-"));
  const port=Number(process.env.WARP_TEST_PORT||8879);
  const site="http://127.0.0.1:"+port+"/index.html";
  const server=spawn(process.env.PYTHON_BIN||"python3",
    ["-m","http.server",String(port),"--bind","127.0.0.1"],{
      cwd:resolve(process.env.WARP_WEB_ROOT||"_site"),stdio:"ignore"
    });
  let browser;
  try{
    for(let n=0;n<50;n++){
      try{const r=await fetch(site);await r.arrayBuffer();if(r.ok)break;}catch{}
      if(n===49)throw Error("staged Pages server not ready");
      await delay(100);
    }
    browser=await puppeteer.launch({
      executablePath:process.env.CHROME_BIN||"/usr/bin/google-chrome",
      headless:true,args:["--no-sandbox","--disable-dev-shm-usage","--autoplay-policy=no-user-gesture-required"]
    });
    const page=await browser.newPage(),errors=[];
    page.on("pageerror",error=>errors.push(error.message));
    await page.setViewport({width:1365,height:1000});
    // Observe actual native source starts and AudioContext time. Do not
    // substitute a mock worklet, PCM producer or transport.
    await page.evaluateOnNewDocument(()=>{
      const Native=window.AudioContext;
      window.__recordedStarts=[];
      window.__recordedContexts=[];
      window.AudioContext=class extends Native{
        constructor(...args){super(...args);window.__recordedContexts.push(this);}
        createBufferSource(...args){
          const source=super.createBufferSource(...args),start=source.start.bind(source);
          source.start=(...inputs)=>{
            window.__recordedStarts.push({offset:inputs[1]??0,
              seconds:source.buffer?.duration,frames:source.buffer?.length,
              rate:source.buffer?.sampleRate});
            return start(...inputs);
          };
          return source;
        }
      };
    });
    const session=await page.createCDPSession();
    await session.send("Page.setDownloadBehavior",{behavior:"allow",downloadPath:temp});
    await page.goto(site,{waitUntil:"domcontentloaded"});
    await page.waitForFunction(()=>document.documentElement.dataset.fwBoot==="ready",{timeout:20000});
    await (await page.$("#audio-file")).uploadFile(sourcePath);
    await page.waitForFunction(()=>!document.querySelector("#play-wet").disabled,{timeout:20000});
    assert.match(await page.$eval("#file-meta",el=>el.textContent),/3\.0秒.*48000Hz.*1ch/);
    assert.match(await page.$eval("#status",el=>el.textContent),/読み込み完了/);
    const shift=async value=>page.$eval("#axis-shift",(el,v)=>{
      el.value=v;el.dispatchEvent(new Event("input",{bubbles:true}));
    },String(value));
    await shift(.55);
    await page.click("#compare-save-a");

    const wave=await page.$("#wave");
    await wave.scrollIntoView();
    let rect=await wave.boundingBox();
    assert.ok(rect?.width>100);
    await page.mouse.click(rect.x+rect.width*.2,rect.y+rect.height/2);
    assert.equal(await page.$eval("#stop",el=>el.disabled),true);
    await page.click("#play-wet");
    await page.waitForFunction(()=>document.querySelector("#rt-indicator").textContent.includes("稼働中")&&
      !document.querySelector("#stop").disabled,{timeout:25000});
    const nativeStart=await page.evaluate(()=>window.__recordedStarts.at(-1));
    assert.ok(nativeStart?.seconds>=2.99&&nativeStart.seconds<=3.01);
    assert.ok(Math.abs(nativeStart.offset-.6)<.08,"selected position must reach native source");
    const clock=await page.evaluate(()=>window.__recordedContexts.find(c=>c.state==="running")?.currentTime);
    assert.ok(Number.isFinite(clock));
    await page.waitForFunction(t=>window.__recordedContexts.some(c=>c.state==="running"&&c.currentTime>t+.15),
      {timeout:10000},clock);

    await shift(.65);
    await page.click("#compare-save-b");
    await page.click("#compare-load-a");
    await page.waitForFunction(()=>document.querySelector("#comparison-status").dataset.phase==="applied",
      {timeout:15000});
    assert.ok(Math.abs(Number(await page.$eval("#axis-shift",el=>el.value))-.55)<.051);
    await page.click("#compare-load-b");
    await page.waitForFunction(()=>document.querySelector("#comparison-status").dataset.phase==="applied",
      {timeout:15000});
    assert.ok(Math.abs(Number(await page.$eval("#axis-shift",el=>el.value))-.65)<.051);
    const starts=await page.evaluate(()=>window.__recordedStarts.length);
    await wave.scrollIntoView();
    rect=await wave.boundingBox();
    await page.mouse.click(rect.x+rect.width*.5,rect.y+rect.height/2);
    await page.waitForFunction(count=>window.__recordedStarts.length>count&&
      Math.abs(window.__recordedStarts.at(-1).offset-1.5)<.08,{timeout:10000},starts);
    await page.click("#stop");
    await page.waitForFunction(()=>document.querySelector("#stop").disabled,{timeout:10000});

    // Actual export/download path. Read downloaded bytes with the existing
    // canonical bounded PCM reader, rather than asserting only button state.
    await page.$eval("#wet",el=>{el.value="1";el.dispatchEvent(new Event("input",{bubbles:true}));});
    await page.click("#export-toggle");
    await page.click("#render");
    await page.waitForFunction(()=>!document.querySelector("#download").disabled,{timeout:45000});
    assert.equal(await page.$eval("#progress",el=>Number(el.value)),100);
    const output=join(temp,filename.replace(/\.wav$/,"-frequency-warp.wav"));
    await page.click("#download");
    const wet=await samples(await downloadedBytes(output));
    const processed=measure(wet,original);
    assert.ok(processed.rms>1e-4,"exported recording must not be silent");
    assert.ok(processed.differenceRms>1e-4,"nonidentity transform must change PCM");
    await rename(output,join(temp,"wet.wav"));
    // Mix is a download-time blend; no second DSP render is needed.
    await page.waitForFunction(()=>!document.querySelector("#download").disabled);
    await page.$eval("#wet",el=>{el.value="0";el.dispatchEvent(new Event("input",{bubbles:true}));});
    assert.equal(await page.$eval("#download",el=>el.disabled),false);
    await page.click("#download");
    const dry=measure(await samples(await downloadedBytes(output)),original);
    assert.ok(dry.differenceRms<=2/32768,"0% Mix must preserve original PCM within PCM16 quantization");
    console.log("RECORDED_PIANO_309 "+JSON.stringify({input,processed,dry,nativeStart,
      sampleRate:48000,frames:144000,channels:1,fixture:filename}));
    assert.deepEqual(errors,[]);
  }finally{
    await browser?.close();
    server.kill();
    await rm(temp,{recursive:true,force:true});
  }
});
