Warning: truncated output (original token count: 21796)
Total output lines: 1464

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
    {cwd:path.resolve(process.env.WARP_WEB_ROOT||"web-demo"),stdio:"ignore"});
  let browser;
  try{
    const wavPath=path.join(temp,"twelve.wav");await writeFile(wavPath,sineWav());
    browser=await puppeteer.launch({
      executablePath:process.env.CHROME_BIN||"/usr/bin/google-chrome",
      headless:true,
      args:["--no-sandbox","--disable-dev-shm-usage","--autoplay-policy=no-user-gesture-required"]
    });
    const page=await browser.newPage();
    // #240: independently observe the real AudioContext clock in the Chrome
    // page; do not mistake a stalled UI label for stopped source playback.
    await page.evaluateOnNewDocument(()=>{
      const Native=window.AudioContext;
      if(!Native)return;
      window.__originalPlaybackAuditContexts=[];
      window.AudioContext=class extends Native{
        constructor(...args){
          super(...args);
          this.__auditSourceStarts=[];
          window.__originalPlaybackAuditContexts.push(this);
        }
        createBufferSource(...args){
          const source=super.createBufferSource(...args);
          const start=source.start.bind(source);
          source.start=(...inputs)=>{
            this.__auditSourceStarts.push({
              when:inputs[0],offset:inputs[1]??0,duration:source.buffer?.duration??null,
              activeAtStart:this.currentTime,stateAtStart:this.state
            });
            return start(...inputs);
          };
          return source;
        }
      };
    });
    const errors=[];
    page.on("pageerror",e=>errors.push(e.message));
    let okay=false;
    for(let i=0;i<36;i++){
      try{
        const resp=await page.goto("http://127.0.0.1:8765/index.html?legacy_lab=1");
        if(resp?.ok()){okay=true;break;}
      }catch{}
      await new Promise(r=>setTimeout(r,250));
    }
    assert.ok(okay,"page not served");
    await page.waitForFunction(()=>document.querySelector("#curve").width===document.querySelector("#curve").height&&
      document.querySelectorAll("#math-results math").length>=5 && document.querySelector("#mini-fundamental")?.textContent.includes("→"),{timeout:16000})
      .catch(async err=>{throw Error("UI boot failed: "+JSON.stringify(await page.evaluate(()=>({
        math:document.querySelector("#math-results")?.textContent,curve:[
          document.querySelector("#curve").width,document.querySelector("#curve").height],
        errors:window.__uiErrors||[]
      })))+" | "+err.message);});
    const dimensions=await page.$eval("#curve",el=>({w:el.width,h:el.height}));
    assert.equal(dimensions.w,dimensions.h,"20-2kHz mapping must be square");
    assert.equal(await page.$eval("#invert",el=>el.value),"0");
    assert.equal(await page.$eval("#engine",el=>el.value),"1","B must be initial manual engine");
    assert.equal(await page.$eval("#mode",el=>el.value),"reciprocal");
    assert.equal(await page.$eval("#mode",el=>[...el.options].some(x=>x.value==="blend")),false,"simple blend must not be user-selectable");
    assert.equal(await page.$eval("#harmonic-count",el=>el.value),"5");
    assert.equal(await page.$eval("#decimal-digits",el=>el.value),"1");
    assert.equal(await page.$eval("#graph-log",el=>el.value),"0");
    assert.equal(await page.$eval("#sine-heading",el=>el.textContent),"補助音");
    assert.equal(await page.$eval("#sine-volume",el=>el.value),"25");
    await page.$eval("#sine-volume",el=>{
      el.value="40";el.dispatchEvent(new Event("input",{bubbles:true}));
    });
    assert.equal(await page.$eval("#sine-volume-value",el=>el.textContent),"40%");
    // Fold/reference Hz must remain visible without opening the tooltip.
    const shapeMarker=await page.$eval("#invert-reference-hz",el=>({
      text:el.textContent,
      height:el.getBoundingClientRect().height,
      parent:el.parentElement.className
    }));
    assert.match(shapeMarker.text,/固定点.*Hz/);
    assert.ok(shapeMarker.height>0&&!shapeMarker.parent.includes("info-body"),
      "fold/reference Hz was accidentally hidden behind the ⓘ tooltip");
    // #309: untouched slope uses 0Hz anchor, so s=2 is f→2f even
    // for low frequencies; the nonzero P setting remains user-selectable.
    assert.equal(await page.$eval("#axis-pivot-value",el=>Number(el.value)),0);
    assert.equal(await page.$eval("#axis-pivot",el=>Number(el.value)),0);
    // Opt-in chain couples H=rF/m with axis pivot and supports reverse input.
    assert.equal(await page.$eval("#harmonic-pivot-link",el=>el.checked),false);
    // Direct F↔P is separate from virtual harmonic H=rF/m.
    // In direct mode denominator m changes the *audible shift*, not pivot P.
    await page.select("#pivot-link-target","F");
    await page.click(".harmonic-pivot-link");
    assert.equal(await page.$eval("#rational-enabled",el=>el.checked),true);
    assert.ok(Math.abs(await page.$eval("#axis-pivot-value",el=>Number(el.value))-350)<.005);
    // A25: a direct F↔P link must align F's draggable rail with the
    // physical pivot rail, rather than silently using H=rF/m.
    const directRail=await page.evaluate(()=>({
      f:Number(document.querySelector("#fundamental-range").value),
      p:Number(document.querySelector("#axis-pivot").value)
    }));
    assert.ok(Math.abs(directRail.f-directRail.p)<=1,
      "F direct mode must use the P rail for F slider and percentage view");
    await page.$eval("#fundamental-range",el=>{
      el.value="650";el.dispatchEvent(new Event("input",{bubbles:true}));
    });
    const directGesture=await page.evaluate(()=>({
      F:Number(document.querySelector("#fundamental").dataset.fwCanonical),
      P:Number(document.querySelector("#axis-pivot-value").dataset.fwCanonical)
    }));
    assert.ok(directGesture.F>350 && Math.abs(directGesture.F-directGesture.P)<.01,
      "F rail drag must change physical P by the identical Hz, independent of m and r");
    await page.$eval("#fundamental",el=>{
      el.value="350";el.dispatchEvent(new Event("input",{bubbles:true}));
    });
    await page.$eval("#denominator",el=>{
      el.value="5";el.dispatchEvent(new Event("input",{bubbles:true}));
    });
    assert.ok(Math.abs(await page.$eval("#axis-pivot-value",el=>Number(el.value))-350)<.005,
      "m must not shift the physical F-linked pivot");
    assert.match(await page.$eval("#harmonic-audio-status",el=>el.textContent),/有理数シフトON.*Δ=/);
    await page.$eval("#axis-pivot-value",el=>{
      el.value="660";el.dispatchEvent(new Event("input",{bubbles:true}));
    });
    assert.ok(Math.abs(await page.$eval("#fundamental",el=>Number(el.value))-660)<.005,
      "P→F in direct mode is P=F, never mP/r");
    await page.$eval("#harmonic-pivot-link",el=>{
      el.checked=false;el.dispatchEvent(new Event("change",{bubbles:true}));
    });
    assert.equal(await page.$eval("#rational-enabled",el=>el.checked),false,
      "F link restores previously disabled rational DSP");
    await page.$eval("#fundamental",el=>{
      el.value="350";el.dispatchEvent(new Event("input",{bubbles:true}));
    });
    await page.$eval("#denominator",el=>{
      el.value="4";el.dispatchEvent(new Event("input",{bubbles:true}));
    });
    await page.select("#pivot-link-target","H");
    await page.click(".harmonic-pivot-link");
    assert.equal(await page.$eval("#harmonic-pivot-link",el=>el.checked),true);
    assert.equal(await page.$eval("#rational-enabled",el=>el.checked),true,
      "the explicitly audible H↔P link must activate rational DSP, not only mathematical displays");
    assert.ok(Math.abs(await page.$eval("#axis-pivot-value",el=>Number(el.value))-87.5)<.002);
    const harmonicRail=await page.evaluate(()=>({
      f:Number(document.querySelector("#fundamental-range").value),
      p:Number(document.querySelector("#axis-pivot").value)
    }));
    assert.ok(Math.abs(harmonicRail.f-harmonicRail.p)<=1,
      "H-linked F slider must project H=rF/m onto physical pivot rail");
    await page.click("#tab-math");
    for(const [id,value] of [["fundamental","480"],["denominator","5"]]){
      await page.$eval("#"+id,(el,v)=>{
        el.value=v;el.dispatchEvent(new Event("input",{bubbles:true}));
      },value);
    }
    assert.ok(Math.abs(await page.$eval("#axis-pivot-value",el=>Number(el.value))-96)<.002);
    await page.$eval("#axis-pivot-value",el=>{
      el.value="120";el.dispatchEvent(new Event("input",{bubbles:true}));
    });
    assert.ok(Math.abs(await page.$eval("#fundamental",el=>Number(el.value))-600)<.005,
      "pivot→F must solve F=mP/r without recursive updates");
    await page.$eval("#pitch-ratio",el=>{
      el.value="2";el.dispatchEvent(new Event("input",{bubbles:true}));
    });
    assert.ok(Math.abs(await page.$eval("#axis-pivot-value",el=>Number(el.value))-240)<.005,
      "F/r/m→H→pivot must include pitch ratio");
    // Theoretical F may extend far above physical P. The earlier linked
    // behavior silently rewrote F down to fit P <= 20kHz.
    await page.$eval("#fundamental",el=>{
      el.value="100000";el.dispatchEvent(new Event("input",{bubbles:true}));
    });
    assert.equal(await page.$eval("#fundamental",el=>Number(el.value)),100000,
      "out-of-range derived H must NEVER silently rewrite theoretical F");
    assert.equal(await page.$eval("#axis-pivot-value",el=>Number(el.value)),240,
      "physical pivot retains previous accepted value");
    assert.equal(await page.$eval("#harmonic-pivot-link",el=>el.checked),false,
      "impossible physical link must visibly disengage");
    assert.match(await page.$eval("#harmonic-pivot-link-note",el=>el.textContent),
      /連動解除.*H=40000.*20,000.*Fの値と起点Pは保持/);
    await page.$eval("#fundamental",el=>{
      el.value="600";el.dispatchEvent(new Event("input",{bubbles:true}));
    });
    assert.equal(await page.$eval("#harmonic-pivot-link-note",el=>el.hidden),true);
    await page.$eval("#harmonic-pivot-link",el=>{
      el.checked=true;el.dispatchEvent(new Event("change",{bubbles:true}));
    });
    assert.equal(await page.$eval("#harmonic-pivot-link",el=>el.checked),true);
    assert.ok(Math.abs(await page.$eval("#axis-pivot-value",el=>Number(el.value))-240)<.005,
      "valid relink restores H=rF/m without changing F or P");
    await page.$eval("#fundamental",el=>{
      el.value="0.001";el.dispatchEvent(new Event("input",{bubbles:true}));
    });
    assert.equal(await page.$eval("#fundamental",el=>Number(el.value)),.001,
      "sub-0.001Hz physical H must not force theoretical F to a different value");
    assert.equal(await page.$eval("#harmonic-pivot-link",el=>el.checked),false);
    assert.match(await page.$eval("#harmonic-pivot-link-note",el=>el.textContent),
      /連動解除.*0.001.*20,000.*Fの値と起点Pは保持/);
    await page.$eval("#fundamental",el=>{
      el.value="600";el.dispatchEvent(new Event("input",{bubbles:true}));
    });
    await page.$eval("#harmonic-pivot-link",el=>{
      el.checked=true;el.dispatchEvent(new Event("change",{bubbles:true}));
    });
    await page.$eval("#harmonic-pivot-link",el=>{
      el.checked=false;el.dispatchEvent(new Event("change",{bubbles:true}));
    });
    await page.$eval("#fundamental",el=>{
      el.value="350";el.dispatchEvent(new Event("input",{bubbles:true}));
    });
    assert.ok(Math.abs(await page.$eval("#axis-pivot-value",el=>Number(el.value))-240)<.005,
      "unlink must preserve the independent existing pivot value");
    for(const [id,value] of [["denominator","4"],["pitch-ratio","1"]]){
      await page.$eval("#"+id,(el,v)=>{
        el.value=v;el.dispatchEvent(new Event("input",{bubbles:true}));
      },value);
    }
    await page.$eval("#axis-pivot-value",el=>{
      el.value="350";el.dispatchEvent(new Event("input",{bubbles:true}));
    });
    await page.click("#tab-map");
    // A22: optional L→P minimum constraint remains distinct from the
    // H↔P harmonic link; current L=.001 allows P=10 instead of imposing 20.
    await page.$eval("#pivot-follow-low",el=>{
      el.checked=true;el.dispatchEvent(new Event("change",{bubbles:true}));
    });
    await page.$eval("#axis-pivot-value",el=>{
      el.value="10";el.dispatchEvent(new Event("input",{bubbles:true}));
    });
    assert.ok(Math.abs(await page.$eval("#axis-pivot-value",el=>Number(el.value))-10)<.01);
    await page.$eval("#low-value",el=>{
      el.value="30";el.dispatchEvent(new Event("input",{bubbles:true}));
    });
    assert.ok(Math.abs(await page.$eval("#axis-pivot-value",el=>Number(el.value))-30)<.01);
    await page.$eval("#pivot-follow-low",el=>{
      el.checked=false;el.dispatchEvent(new Event("change",{bubbles:true}));
    });
    await page.$eval("#axis-pivot-value",el=>{
      el.value="350";el.dispatchEvent(new Event("input",{bubbles:true}));
    });
    await page.$eval("#low-value",el=>{
      el.value="20";el.dispatchEvent(new Event("input",{bubbles:true}));
    });

    assert.equal(await page.$eval(".dual-range",el=>el.querySelectorAll("input[type=range]").length),2);
    for(const root of ["reflection-dual","shape-dual","dual-range"]){
      const shape=await page.$eval("#"+root,el=>({
        sources:el.querySelectorAll("input[type=range]").length,
        thumbs:el.querySelectorAll("[role=slider]").length,
        inner:el.querySelector("[data-dual-inner]")?.getBoundingClientRect().height,
        track:el.getBoundingClientRect().height
      }));
      assert.equal(shape.sources,2,root+" must preserve both native Rust parameters");
      assert.equal(shape.thumbs,2,root+" must have TWO accessible thumbs");
      assert.ok(shape.track>=40&&shape.inner>=40,root+" must have one useable track");
    }
    const dragDual=async(root,which,from,to)=>{
      await page.$eval("#"+root,el=>el.scrollIntoView({block:"center"}));
      const b=await page.$eval("#"+root+" [data-dual-inner]",el=>{
        const r=el.getBoundingClientRect();
        return {x:r.x,y:r.y,width:r.width,height:r.height};
      });
      const y=b.y+(which===0?11:b.height-11);
      await page.mouse.move(b.x+from*b.width,y);
      await page.mouse.down();
      await page.mouse.move(b.x+to*b.width,y,{steps:7});
      await page.mouse.up();
    };
    // Genuine Chrome pointer-drag, not element.value assignment: moving
    // ONE thumb MUST NOT move its companion.
    await dragDual("reflection-dual",0,1,.40);
    assert.ok(Math.abs(Number(await page.$eval("#zero-reflect",n=>n.value))-40)<=2);
    assert.equal(await page.$eval("#zero-decay",n=>n.value),"0");
    await dragDual("reflection-dual",1,0,.65);
    assert.ok(Math.abs(Number(await page.$eval("#zero-decay",n=>n.value))-65)<=2);
    assert.…13796 tokens truncated…wait page.$eval("#a-band",el=>{el.value="6";el.dispatchEvent(new Event("input",{bubbles:true}));});
    assert.equal(await page.$eval("#a-band-value",el=>Number(el.value)),6);
    await page.$eval("#a-quality",el=>{el.value="80";el.dispatchEvent(new Event("input",{bubbles:true}));});
    assert.equal(await page.$eval("#a-quality-value",el=>Number(el.value)),80);
    assert.match(await page.$eval("#a-quality-info",el=>el.textContent),/最大ピーク.*本/);
    try {
      await page.waitForFunction(()=>/操作反映済み|稼働中/.test(
        document.querySelector("#rt-indicator").textContent),{timeout:25000});
    }catch(error){
      const snapshot=await page.evaluate(()=>({
        indicator:document.querySelector("#rt-indicator").textContent,
        status:document.querySelector("#status").textContent,
        quality:document.querySelector("#a-quality").value,
        engine:document.querySelector("#engine").value,
        debug:window.__warpDebug?.()
      }));
      throw Error("A quality slider AudioWorklet: "+JSON.stringify(snapshot)+" / "+error.message);
    }

    await page.$eval("#a-reverb",el=>{el.value="35";el.dispatchEvent(new Event("input",{bubbles:true}));});
    assert.equal(await page.$eval("#a-reverb-value",el=>el.value),"35");
    await page.select("#engine","1");
    assert.equal(await page.$eval("#engine-a-settings",el=>el.hidden),true);
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
    // Contextual help must remain on-screen when opened in the narrow graph column.
    await page.click(".graph-scale .info-tip summary");
    const popoverBounds=await page.$eval(".graph-scale .info-body",el=>{
      const r=el.getBoundingClientRect();
      return {left:r.left,right:r.right,width:r.width,screen:document.documentElement.clientWidth};
    });
    assert.ok(popoverBounds.left>=-1 && popoverBounds.right<=popoverBounds.screen+1,
      "mobile help panel escaped viewport "+JSON.stringify(popoverBounds));
    await page.click(".graph-scale .info-tip summary");
    assert.ok(layout.curve.width<=210,"Mobile graph should use freed space for sliders "+JSON.stringify(layout));
    assert.equal(await page.$eval("#view-map",el=>el.hidden),false);
    assert.match(await page.$eval("#mini-harmonics",el=>el.textContent),/3：/);
    await page.click("#settings-open");
    const modalScroll=await page.evaluate(()=>{
      const body=document.querySelector(".settings-body");
      const overflow=body.scrollHeight-body.clientHeight;
      body.scrollTop=body.scrollHeight;
      return {overflow,top:body.scrollTop};
    });
    assert.ok(modalScroll.overflow>30&&modalScroll.top>30,"settings must scroll on small displays: "+JSON.stringify(modalScroll));
    await page.select("#harmonic-count","12");
    await page.click("#settings-done");
    await page.click("#crusher-enabled");
    assert.equal(await page.$eval("#fx-wave-preview",el=>el.hidden),false,
      "bitcrusher on must show a source/processed waveform");
    await page.$eval("#crusher-bits",el=>{el.value="3";el.dispatchEvent(new Event("input",{bubbles:true}));});
    assert.equal(await page.$eval("#crusher-bits-value",el=>el.value),"3");
    const crusherMin=await page.$eval("#crusher-hold",el=>el.min);
    const crusherMax=await page.$eval("#crusher-hold",el=>el.max);
    assert.equal(crusherMin,"0");
    assert.equal(crusherMax,"1000");
    await page.$eval("#crusher-hold",el=>{el.value="0";el.dispatchEvent(new Event("input",{bubbles:true}));});
    const slow=Number(await page.$eval("#crusher-hold-value",el=>el.value));
    assert.equal(slow,0,"leftmost update frequency must reach exactly 0Hz");
    assert.match(await page.$eval("#crusher-rate-explainer",el=>el.textContent),/0 Hz.*更新停止/);
    assert.equal(await page.$eval("#curve",el=>el.dataset.crusherSpectrum),"dc-frozen");
    assert.equal(await page.$eval("#curve",el=>Number(el.dataset.crusherUpdateHz)),0);
    await page.$eval("#crusher-hold",el=>{el.value="1000";el.dispatchEvent(new Event("input",{bubbles:true}));});
    const fast=Number(await page.$eval("#crusher-hold-value",el=>el.value));
    assert.ok(fast>slow*20,"crusher Hz slider must INCREASE toward the right");
    assert.match(await page.$eval("#crusher-rate-explainer",el=>el.textContent),/実効.*Hz/);
    const shape=await page.$eval("#crusher-preview",el=>({w:el.width,h:el.height}));
    assert.ok(shape.w>180&&shape.h>=80,"crusher visual must render at mobile size");
    await page.$eval("#crusher-hold",el=>{el.value="600";el.dispatchEvent(new Event("input",{bubbles:true}));});
    assert.equal(await page.$eval("#crusher-alias-legend",el=>el.hidden),false);
    assert.equal(await page.$eval("#curve",el=>el.dataset.crusherSpectrum),
      "linear-zoh-images-before-quantizer");
    const info=await page.$eval("#curve",el=>({
      rate:Number(el.dataset.crusherUpdateHz),
      mirror:Number(el.dataset.crusherMirrorHz)
    }));
    assert.ok(info.rate>0 && Math.abs(info.mirror-info.rate/2)<.001);
    assert.match(await page.$eval("#crusher-alias-note",el=>el.textContent),/平均実効更新 .* Hz/);
    assert.match(await page.$eval("#crusher-alias-note",el=>el.textContent),/比較モデル/);
    const graphOn=await page.$eval("#curve",el=>el.toDataURL());
    await page.$eval("#crusher-hold",el=>{
      el.value="1000";el.dispatchEvent(new Event("input",{bubbles:true}));
    });
    const graphOff=await page.$eval("#curve",el=>el.toDataURL());
    assert.notEqual(graphOn,graphOff,"main graph must show real sample-hold spectral branches");
    await page.$eval("#crusher-bits",el=>{
      el.value="2";el.dispatchEvent(new Event("input",{bubbles:true}));
    });
    const coarse=await page.$eval("#crusher-preview",el=>el.toDataURL());
    await page.$eval("#crusher-bits",el=>{
      el.value="8";el.dispatchEvent(new Event("input",{bubbles:true}));
    });
    const fine=await page.$eval("#crusher-preview",el=>el.toDataURL());
    assert.notEqual(coarse,fine,"faint quantisation-memory level lines must change with number of bits");

    await page.click("#mini-expand");
    assert.equal(await page.$eval("#view-map",el=>el.hidden),false,"graph must stay visible when equations open");
    assert.equal(await page.evaluate(()=>document.activeElement?.textContent?.trim()),"仮想基音と倍音",
      "Opening expert detail must focus the revealed heading");
    const detailRect=await page.$eval("#view-math .section-header h2",el=>{
      const r=el.getBoundingClientRect();return {top:r.top,bottom:r.bottom,height:innerHeight};
    });
    assert.ok(detailRect.top>=0&&detailRect.bottom<=detailRect.height,
      "Expert detail must scroll into the visible viewport: "+JSON.stringify(detailRect));
    assert.match(await page.$eval("#harmonic-table-title",el=>el.textContent),/12倍音/);
    const harmonics=await page.$eval("#harmonics-body",el=>el.children.length);
    assert.equal(harmonics,12);
    await page.click("#tab-map");

    // Check a 601s source retains its complete duration, without silent 600s truncation.
    const longPath=path.join(temp,"six-hundred.wav");
    await writeFile(longPath,sineWav(601));
    await (await page.$("#audio-file")).uploadFile(longPath);
    await page.waitForFunction(()=>document.querySelector("#file-meta").textContent.includes("601.0秒"),{timeout:45000});
    assert.equal(await page.$eval("#duration",el=>el.textContent),"10:01.0");
    await page.$eval("#wave",el=>el.scrollIntoView({block:"center",behavior:"instant"}));
    const longWave=await (await page.$("#wave")).boundingBox();
    assert.equal(await page.$eval("#stop",el=>el.disabled),true);
    await page.mouse.click(longWave.x+longWave.width*.9,longWave.y+longWave.height/2);
    assert.equal(await page.$eval("#stop",el=>el.disabled),true,
      "Waveform seek while stopped must not silently launch processed audio");
    const pausedPosition=await page.$eval("#elapsed",el=>{
      const [m,sec]=el.textContent.split(":").map(Number);return m*60+sec;
    });
    assert.ok(Math.abs(pausedPosition-540)<3,"Waveform seeks without starting: "+pausedPosition);
    assert.equal(await page.$eval("#wave",el=>el.getAttribute("role")),"slider");
    const initialAccessible=await page.$eval("#wave",el=>Number(el.getAttribute("aria-valuenow")));
    assert.ok(initialAccessible>=89&&initialAccessible<=91,
      "Accessible waveform seek should describe the actual selected position");
    await page.focus("#wave");
    await page.keyboard.press("ArrowRight");
    assert.equal(await page.$eval("#stop",el=>el.disabled),true,
      "Keyboard seek must not silently start Wet processing");
    const keyboardPosition=await page.$eval("#elapsed",el=>{
      const [m,sec]=el.textContent.split(":").map(Number);return m*60+sec;
    });
    assert.ok(Math.abs(keyboardPosition-pausedPosition-2)<.2,"ArrowRight adds two seconds");
    // The deliberate transport choice owns playback mode and retains seek.
    await page.click("#play-wet");
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
        throw Error("600-second deliberate playback start: "+JSON.stringify(state)+" | "+err.message);
      });
    const soughtSeconds=await page.$eval("#elapsed",el=>{
      const [m,sec]=el.textContent.split(":").map(Number);
      return m*60+sec;
    });
    assert.ok(Math.abs(soughtSeconds-542)<3,
      "Explicit Wet start uses selected 9:02 position, got "+soughtSeconds);
    await page.click("#stop");
    // A18: a genuinely unrecoverable Worklet parameter failure must not
    // leave the user hearing an untrusted partial-DSP stream or silence.
    // Inject a fatal processor message into the REAL running Chrome Worklet
    // port; Rust setter failure timing is tested separately in VM.
    await page.evaluate(()=>{
      const Native=window.AudioWorkletNode;
      window.__a18NativeWorkletNode=Native;
      window.AudioWorkletNode=class extends Native{
        constructor(...args){super(...args);window.__a18Worklet=this;}
      };
    });
    await page.click("#play-wet");
    await page.waitForFunction(()=>
      !document.querySelector("#stop").disabled&&
      document.querySelector("#rt-indicator").textContent.includes("稼働中"),
      {timeout:25000});
    await page.evaluate(()=>window.__a18Worklet.port.onmessage({
      data:{type:"error",revision:0,fatal:true,message:"injected unrecoverable late setter"}
    }));
    await page.waitForFunction(()=>
      !document.querySelector("#stop").disabled &&
      document.querySelector("#rt-indicator").textContent.includes("原音再生中"),
      {timeout:20000});
    assert.match(await page.$eval("#status",el=>el.textContent),
      /変換の復旧に失敗したため、原音再生へ退避/);
    await page.click("#stop");
    await page.evaluate(()=>{
      window.AudioWorkletNode=window.__a18NativeWorkletNode;
      delete window.__a18NativeWorkletNode;
      delete window.__a18Worklet;
    });
    // Reproduce a cold iOS decoder that never settles on its first path.
    // The first file selection on a NEW page must recover on its own.
    const coldPage=await browser.newPage();
    await coldPage.goto("http://127.0.0.1:8765/index.html?legacy_lab=1");
    await coldPage.evaluate(()=>{
      OfflineAudioContext.prototype.decodeAudioData=function(){
        return new Promise(()=>{});
      };
    });
    await (await coldPage.$("#audio-file")).uploadFile(wavPath);
    await coldPage.waitForFunction(()=>!document.querySelector("#play-wet").disabled,
      {timeout:21000}).catch(async err=>{
      const status=await coldPage.$eval("#status",el=>el.textContent);
      throw Error("cold-start recovery: "+status+" | "+err.message);
    });
    assert.match(await coldPage.$eval("#status",el=>el.textContent),/読み込み完了/);
    assert.equal(await coldPage.$eval("#file-meta",el=>el.textContent.includes("12.0秒")),true);
    await coldPage.close();
    await page.close();
  }finally{
    if(browser)await browser.close();
    server.kill("SIGTERM");
    await rm(temp,{recursive:true,force:true});
  }
});
