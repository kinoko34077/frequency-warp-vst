import {test} from "node:test";
import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {resolve} from "node:path";
import puppeteer from "puppeteer-core";
test("V5 virtual harmonic UI: linear integer sliders, live audio config, signed auto-fold, units, A/B, media pause",{
  timeout:120000
},async()=>{
  const server=spawn("python3",["-m","http.server","8798","--bind","127.0.0.1"],{
    cwd:resolve(process.env.WARP_WEB_ROOT||"_site"),stdio:"ignore"
  });
  let browser;
  try{
    browser=await puppeteer.launch({executablePath:process.env.CHROME_BIN||"/usr/bin/google-chrome",
      headless:true,args:["--no-sandbox","--disable-dev-shm-usage"]});
    for(const width of [320,390,768]){
      const page=await browser.newPage();
      await page.setViewport({width,height:844,deviceScaleFactor:1,isMobile:width<=390,hasTouch:width<=390});
      const errors=[];page.on("pageerror",err=>errors.push(err.message));
      await page.goto("http://127.0.0.1:8798/index.html",{waitUntil:"domcontentloaded"});
      await page.waitForFunction(()=>document.documentElement.dataset.fwBoot==="ready",{timeout:20000});
      assert.equal(await page.$eval("#vr-target-h",el=>el.value),"87.5");
      assert.equal(await page.$eval("#vr-target-h-rail",el=>[el.min,el.max,el.step].join("|")),"1|200|1");
      assert.equal(await page.$eval("#vr-source-f-rail",el=>el.max),"1000");
      await page.select("#vr-target-h-scale","1000");
      assert.equal(await page.$eval("#vr-target-h-rail",el=>el.max),"1000");
      assert.equal(await page.$eval("#vr-target-h",el=>el.value),"87.5",
        "Changing the linear span must not alter canonical H");
      await page.select("#vr-target-h-scale","200");
      assert.equal(await page.$eval("#vr-target-h-rail",el=>el.max),"200");
      assert.equal(await page.$eval("#vr-step-m-rail",el=>el.step),"1");
      assert.equal(await page.$eval("#vr-first-index-rail",el=>el.min),"-129");
      assert.equal(await page.$eval("#vr-details",el=>el.open),false);
      assert.equal(await page.$("#vr-apply"),null,"No mandatory Apply click");
      assert.equal(await page.$("#vr-mode"),null,"No explicit fold mode");
      assert.match(await page.$eval("#vr-sequence",el=>el.textContent),/倍音列: 1, 5, 9/);
      assert.equal(await page.$eval("#vr-formula [role=math]",el=>el.getAttribute("aria-label")),"-3 / 4");
      await page.$eval("#vr-target-h-rail",el=>{
        el.value="90";el.dispatchEvent(new Event("input",{bubbles:true}));
      });
      await page.waitForFunction(()=>document.querySelector("#numerator").value==="-3" &&
        document.querySelector("#fundamental").value==="350",{timeout:10000});
      assert.equal(await page.$eval("#vr-target-h",el=>el.value),"90");
      assert.match(await page.$eval("#vr-sequence",el=>el.textContent),/倍音列: 1, 5, 9/);
      await page.$eval("#vr-target-h",el=>{
        el.value="87.25";el.dispatchEvent(new Event("input",{bubbles:true}));
      });
      await page.waitForFunction(()=>document.querySelector("#vr-sequence").textContent.includes("1, 5, 9"));
      assert.equal(await page.$eval("#vr-target-h",el=>el.value),"87.25");
      // Native frequency-codec unit switch must not rewrite canonical H.
      await page.click('[data-vr-unit-for="target-h"][data-vr-unit="note"]');
      assert.match(await page.$eval("#vr-target-h",el=>el.value),/^[A-G]/);
      await page.click('[data-vr-unit-for="target-h"][data-vr-unit="hz"]');
      assert.equal(await page.$eval("#vr-target-h",el=>el.value),"87.25");
      // #291: switching to note is display-only; dragging in note mode
      // must use the shared nearest-semitone magnetic gesture snap.
      await page.click('[data-vr-unit-for="target-h"][data-vr-unit="note"]');
      await page.$eval("#vr-target-h-rail",el=>{
        el.value="90";el.dispatchEvent(new Event("input",{bubbles:true}));
      });
      await page.click('[data-vr-unit-for="target-h"][data-vr-unit="hz"]');
      const snappedHz=Number(await page.$eval("#vr-target-h",el=>el.value));
      assert.ok(Math.abs(snappedHz-92.5)<0.05,"expected nearest F#2 pitch: "+snappedHz);
      await page.$eval("#vr-target-h",el=>{
        el.value="87.25";el.dispatchEvent(new Event("input",{bubbles:true}));
      });
      // #293 percent mode is integer RAIL-% snapping, not whole-Hz snapping.
      assert.equal(await page.$eval("#vr-target-h-rail",el=>el.dataset.fwSnap),"on");
      await page.click('[data-vr-unit-for="target-h"][data-vr-unit="percent"]');
      await page.$eval("#vr-target-h-rail",el=>{
        el.value="90";el.dispatchEvent(new Event("input",{bubbles:true}));
      });
      assert.equal(await page.$eval("#vr-target-h",el=>el.value),"45",
        "90Hz gesture snaps to 45% of 1..200Hz actual physical rail");
      await page.click('[data-vr-unit-for="target-h"][data-vr-unit="hz"]');
      assert.equal(await page.$eval("#vr-target-h",el=>el.value),"90.55");
      // Shared snap OFF context menu is usable on special virtual-root rails.
      await page.$eval("#vr-target-h-rail",el=>el.dispatchEvent(new MouseEvent(
        "contextmenu",{bubbles:true,cancelable:true,clientX:80,clientY:100})));
      assert.equal(await page.$eval("#fw-unit-snap-menu",el=>el.hidden),false);
      assert.match(await page.$eval("#fw-unit-snap-menu button",el=>el.textContent),/オフ/);
      await page.$eval("#fw-unit-snap-menu button",el=>el.click());
      assert.equal(await page.$eval("#vr-target-h-rail",el=>el.dataset.fwSnap),"off");
      assert.equal(await page.$eval("#vr-source-f-rail",el=>el.dataset.fwSnap),"on",
        "F has an independent default ON snap preference");
      await page.click('[data-vr-unit-for="target-h"][data-vr-unit="percent"]');
      await page.$eval("#vr-target-h-rail",el=>{
        el.value="90";el.dispatchEvent(new Event("input",{bubbles:true}));
      });
      await page.click('[data-vr-unit-for="target-h"][data-vr-unit="hz"]');
      assert.equal(await page.$eval("#vr-target-h",el=>el.value),"90",
        "snap OFF preserves the integer-Hz gesture without snapping rail percent");
      await page.$eval("#vr-target-h-rail",el=>el.dispatchEvent(new MouseEvent(
        "contextmenu",{bubbles:true,cancelable:true,clientX:80,clientY:100})));
      assert.match(await page.$eval("#fw-unit-snap-menu button",el=>el.textContent),/オン/);
      await page.$eval("#fw-unit-snap-menu button",el=>el.click());
      await page.$eval("#vr-target-h",el=>{
        el.value="87.25";el.dispatchEvent(new Event("input",{bubbles:true}));
      });
      await page.$eval("#vr-step-m-rail",el=>{
        el.value="4";el.dispatchEvent(new Event("input",{bubbles:true}));
      });
      await page.$eval("#vr-first-index-rail",el=>{
        el.value="-5";el.dispatchEvent(new Event("input",{bubbles:true}));
      });
      assert.match(await page.$eval("#vr-sequence",el=>el.textContent),/倍音列: 5, 1, 3/);
      assert.equal(await page.$eval("#vr-formula [role=math]",el=>el.getAttribute("aria-label")),"-9 / 4");
      await page.waitForFunction(()=>document.querySelector("#numerator").value==="-9",
        {timeout:10000});
      await page.click("#vr-details summary");
      assert.equal(await page.$eval("#vr-details",el=>el.open),true);
      assert.equal(await page.$$eval("#vr-preview [role=listitem]",els=>els.length),8);
      assert.match(await page.$eval("#vr-preview",el=>el.textContent),/0Hz折返し/);
      assert.equal(await page.evaluate(()=>document.querySelectorAll(".vr-counter,.vr-digit-picker").length),0,
        "V5 detached steppers and dropdown collections must be absent");
      assert.equal(await page.$eval("#vr-step-m",el=>el.type),"number");
      if(width<=390){
        await page.click('[data-vr-digit="first-index"]');
        assert.equal(await page.$eval("#vr-wheel-overlay",el=>el.hidden),false);
        assert.equal(await page.evaluate(()=>document.querySelectorAll("#vr-wheel-overlay select").length),0);
        assert.equal(await page.evaluate(()=>document.querySelectorAll(".vr-wheel-track").length),4);
        await page.evaluate(()=>new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done))));
        await page.$eval('.vr-wheel-track[data-wheel-place="sign"]',el=>{
          el.scrollTop=0;el.dispatchEvent(new Event("scroll"));
        });
        await page.waitForFunction(()=>document.querySelector("#vr-first-index").value==="5",
          {timeout:4000});
        await page.click("[data-wheel-cancel]");
        assert.equal(await page.$eval("#vr-first-index",el=>el.value),"-5");
        await page.click('[data-vr-digit="target-h"]');
        assert.equal(await page.evaluate(()=>document.querySelectorAll(".vr-wheel-track").length),7);
        await page.evaluate(()=>new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done))));
        await page.$eval('.vr-wheel-track[data-wheel-place="-2"]',el=>{
          el.scrollTop=6*42;el.dispatchEvent(new Event("scroll"));
        });
        await page.waitForFunction(()=>document.querySelector("#vr-target-h").value==="87.26",
          {timeout:4000});
        await page.click("[data-wheel-done]");
        assert.equal(await page.$eval("#vr-wheel-overlay",el=>el.hidden),true);
      }else{
        assert.equal(await page.$eval('[data-vr-digit="first-index"]',el=>
          getComputedStyle(el).display),"none");
        assert.equal(await page.$eval("#vr-wheel-overlay",el=>el.hidden),true);
      }
      // Original source is needed for canonical comparison snapshots.
      await page.evaluate(()=>{
        const rate=16000,frames=16000*3,buffer=new ArrayBuffer(44+frames*2);
        const view=new DataView(buffer),str=(p,value)=>{
          for(let i=0;i<value.length;i++)view.setUint8(p+i,value.charCodeAt(i));
        };
        str(0,"RIFF");view.setUint32(4,buffer.byteLength-8,true);str(8,"WAVE");
        str(12,"fmt ");view.setUint32(16,16,true);view.setUint16(20,1,true);
        view.setUint16(22,1,true);view.setUint32(24,rate,true);
        view.setUint32(28,rate*2,true);view.setUint16(32,2,true);
        view.setUint16(34,16,true);str(36,"data");view.setUint32(40,frames*2,true);
        for(let i=0;i<frames;i++)view.setInt16(44+i*2,Math.round(8000*Math.sin(2*Math.PI*440*i/rate)),true);
        const input=document.querySelector("#audio-file"),data=new DataTransfer();
        data.items.add(new File([buffer],"harmonics-v5.wav",{type:"audio/wav"}));
        input.files=data.files;input.dispatchEvent(new Event("change",{bubbles:true}));
      });
      await page.waitForFunction(()=>!document.querySelector("#play-dry").disabled,{timeout:25000});
      await page.$eval("#vr-first-index",el=>{
        el.value="3";el.dispatchEvent(new Event("input",{bubbles:true}));
      });
      await page.waitForFunction(()=>document.querySelector("#numerator").value==="-1",{timeout:10000});
      await page.click("#compare-save-a");
      await page.$eval("#vr-first-index",el=>{
        el.value="-5";el.dispatchEvent(new Event("input",{bubbles:true}));
      });
      await page.waitForFunction(()=>document.querySelector("#numerator").value==="-9",{timeout:10000});
      await page.click("#compare-save-b");
      await page.click("#compare-load-a");
      assert.equal(await page.$eval("#vr-first-index",el=>el.value),"3");
      await page.click("#compare-load-b");
      assert.equal(await page.$eval("#vr-first-index",el=>el.value),"-5");
      // Live DSP acceptance: a slider edit must obtain a new Worklet ACK
      // while Wet is audible, with no separate Apply click.
      await page.click("#play-wet");
      await page.waitForFunction(()=>!document.querySelector("#stop").disabled,{timeout:25000});
      const priorRevision=await page.$eval("#rt-indicator",el=>Number(el.dataset.appliedRevision||0));
      await page.$eval("#vr-first-index-rail",el=>{
        el.value="-4";el.dispatchEvent(new Event("input",{bubbles:true}));
      });
      await page.waitForFunction(revision=>
        Number(document.querySelector("#rt-indicator").dataset.appliedRevision||0)>revision,
        {timeout:20000},priorRevision);
      assert.equal(await page.$eval("#numerator",el=>Number(el.value)),-8);
      await page.click("#stop");
      await page.evaluate(()=>{document.querySelector("#background-output").play=()=>Promise.resolve();});
      await page.click("#play-dry");
      await page.waitForFunction(()=>!document.querySelector("#stop").disabled &&
        !!document.querySelector("#background-output").srcObject,{timeout:15000});
      // Simulate iOS remote-control HTMLMediaElement pause; source must stop.
      await page.evaluate(()=>{
        const el=document.querySelector("#background-output");
        el.dispatchEvent(new Event("playing"));
        // iPhone's lock-screen pause arrives with the document hidden; unlike
        // a spontaneous route interruption, it must release the audio loop.
        Object.defineProperty(document,"visibilityState",{configurable:true,get:()=>"hidden"});
        el.dispatchEvent(new Event("pause"));
      });
      await page.waitForFunction(()=>document.querySelector("#stop").disabled,{timeout:10000});
      assert.equal(await page.$eval("#background-output",el=>el.srcObject),null);
      assert.deepEqual(errors,[],width+" JavaScript errors");
      const spill=await page.evaluate(()=>Math.max(0,document.documentElement.scrollWidth-innerWidth));
      assert.ok(spill<=1,"horizontal overflow "+width+": "+spill);
      await page.close();
    }
  }finally{await browser?.close();server.kill("SIGTERM");}
});
