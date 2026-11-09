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
        errors.push(r�N4��$z{-���jםdocument.querySelector("#play-wet").disabled,
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
