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
    assert.equal(await page.$eval("#decimal-digits",el=>el.value),"3");
    assert.equal(await page.$eval("#graph-log",el=>el.value),"0");
    // Fold/reference Hz must remain visible without opening the tooltip.
    const shapeMarker=await page.$eval("#invert-reference-hz",el=>({
      text:el.textContent,
      height:el.getBoundingClientRect().height,
      parent:el.parentElement.className
    }));
    assert.match(shapeMarker.text,/固定点.*Hz/);
    assert.ok(shapeMarker.height>0&&!shapeMarker.parent.includes("info-body"),
      "fold/reference Hz was accidentally hidden behind the ⓘ tooltip");
    // Opt-in chain couples H=rF/m with axis pivot and supports reverse input.
    assert.equal(await page.$eval("#harmonic-pivot-link",el=>el.checked),false);
    await page.click(".harmonic-pivot-link");
    assert.equal(await page.$eval("#harmonic-pivot-link",el=>el.checked),true);
    assert.ok(Math.abs(await page.$eval("#axis-pivot-value",el=>Number(el.value))-87.5)<.002);
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
    assert.ok(Math.abs(Number(await page.$eval("#zero-reflect",n=>n.value))-40)<=2);
    await page.focus("#zero-decay-thumb");
    await page.keyboard.press("ArrowRight");
    assert.ok(Math.abs(Number(await page.$eval("#zero-decay",n=>n.value))-66)<=2,
      "thumb keyboard must update the real source parameter");
    assert.match(await page.$eval("#zero-reflect-status",n=>n.textContent),/合成.*反射/);
    await dragDual("shape-dual",0,0,.32);
    assert.ok(Math.abs(Number(await page.$eval("#invert",n=>n.value))-.32)<.02);
    assert.equal(await page.$eval("#curvature",n=>n.value),"1");
    await dragDual("shape-dual",1,1,.53);
    assert.ok(Math.abs(Number(await page.$eval("#curvature",n=>n.value))-.53)<.02);
    await dragDual("dual-range",1,.968,.82);
    assert.ok(Number(await page.$eval("#high",n=>n.value))<900);
    // Restore the original *unsnapped* DSP fixture while default snap is ON.
    // Holding Alt is the actual temporary bypass used by real users.
    await page.keyboard.down("Alt");
    for(const [id,value] of [["zero-reflect","100"],["zero-decay","0"],
      ["invert","0"],["curvature","1"],["low","200"],["high","974"]]){
      await page.$eval("#"+id,(el,v)=>{
        el.value=v;el.dispatchEvent(new Event("input",{bubbles:true}));
      },value);
    }
    await page.keyboard.up("Alt");

    assert.equal(await page.$eval("#engine",el=>el.value),"1");
    assert.equal(await page.$eval("#math-results",el=>el.querySelectorAll("math").length),5);
    assert.equal(await page.$eval("#math-results",el=>el.textContent.includes("|")),false);
    assert.equal(await page.$eval("#ring-enabled",el=>el.closest(".effects-panel")!==null),true);
    assert.equal(await page.$eval("#crusher-enabled",el=>el.closest(".effects-panel")!==null),true);
    assert.equal(await page.$eval("#carrier",el=>el.closest(".effects-panel")!==null),true);
    assert.equal(await page.$eval("#low",el=>el.value),"200");
    // L/H sliders remain continuous down to positive near-zero, and exact
    // 0.001 Hz typed input reaches the Rust/WASM mapping without truncation.
    assert.equal(await page.$eval("#low-value",el=>el.type),"text",
      "musical note spelling needs text input; typed Hz bounds live in the shared descriptor");
    assert.equal(await page.$eval("#low-unit",el=>el.value),"hz");
    await page.$eval("#low",el=>{
      el.value="0";el.dispatchEvent(new Event("input",{bubbles:true}));
    });
    assert.equal(await page.$eval("#low-value",el=>Number(el.value)),.001);
    await page.$eval("#low-value",el=>{
      el.value="0.001";el.dispatchEvent(new Event("input",{bubbles:true}));
    });
    assert.equal(await page.$eval("#low-value",el=>Number(el.value)),.001);
    await page.$eval("#low",el=>{
      el.value="100";el.dispatchEvent(new Event("input",{bubbles:true}));
    });
    const between=await page.$eval("#low-value",el=>Number(el.value));
    assert.ok(between>0.001&&between<20,"slider must travel continuously below 20Hz: "+between);
    await page.$eval("#low-value",el=>{
      el.value="20";el.dispatchEvent(new Event("input",{bubbles:true}));
    });
    assert.ok(Math.abs(await page.$eval("#low",el=>Number(el.value))-200)<=1);


    assert.equal(await page.$eval("#axis-shift",el=>Number(el.step)),0.05);
    for(const id of ["curvature","invert","wet"]){
      assert.ok(await page.$eval("#"+id,el=>Number(el.step))<=0.005,"percentage slider coarse: "+id);
    }
    assert.equal(await page.$eval("#axis-shift-value",el=>Number(el.step)),0.001);
    // Direct numbers have finer precision than the existing drag step.
    // Input 0.123 must reach the actual coordinate model (0.123*350=43.05 Hz),
    // even when the slider itself snaps to 0.10 Hz-coordinate units.
    await page.$eval("#axis-shift-value",el=>{
      el.value="0.123";el.dispatchEvent(new Event("input",{bubbles:true}));
    });
    assert.equal(await page.$eval("#axis-shift",el=>Number(el.value)),0.1);
    assert.match(await page.$eval("#coordinate-details",el=>el.textContent),/43\.05/);
    await page.$eval("#axis-shift-value",el=>el.blur());
    assert.equal(await page.$eval("#axis-shift-value",el=>Number(el.value)),0.123);
    await page.select("#decimal-digits","2");
    assert.equal(await page.$eval("#axis-shift-value",el=>Number(el.value)),0.12);
    await page.select("#decimal-digits","3");
    assert.equal(await page.$eval("#axis-shift-value",el=>Number(el.value)),0.123);
    await page.$eval("#axis-shift-value",el=>el.focus());
    assert.equal(await page.$eval("#axis-shift-value",el=>Number(el.value)),0.123);
    await page.$eval("#axis-shift-value",el=>el.blur());
    // Percent-unit precision must survive the 1/100 normalization too.
    await page.$eval("#invert-value",el=>{
      el.value="0.123";el.dispatchEvent(new Event("input",{bubbles:true}));
    });
    await page.$eval("#invert-value",el=>el.blur());
    await page.$eval("#invert-value",el=>el.focus());
    assert.equal(await page.$eval("#invert-value",el=>Number(el.value)),0.123);
    await page.$eval("#invert-value",el=>el.blur());
    await page.$eval("#invert",el=>{el.value="0";el.dispatchEvent(new Event("input",{bubbles:true}));});
    await page.$eval("#axis-shift",el=>{el.value="0";el.dispatchEvent(new Event("input",{bubbles:true}));});

    // Frequency slope ×2 with ZERO physical pivot is a normal octave
    // at either curvature endpoint, not the old log-coordinate exponent.
    await page.$eval("#axis-pivot-value",el=>{
      el.value="0";el.dispatchEvent(new Event("change",{bubbles:true}));
    });
    await page.$eval("#axis-slope",el=>{el.value="2";el.dispatchEvent(new Event("input",{bubbles:true}));});
    for(const p of [0,1]){
      await page.$eval("#curvature", (el,p)=>{el.value=String(p);el.dispatchEvent(new Event("input",{bubbles:true}));},p);
      assert.match(await page.$eval("#listening-guide",el=>el.textContent),/500Hz → 1000Hz/);
    }
    assert.equal(await page.$eval("#axis-pivot",el=>Number(el.value)),0);
    assert.equal(await page.$eval("#axis-pivot-value",el=>Number(el.value)),0);
    const beforeLog=await page.$eval("#curve",el=>el.toDataURL());
    await page.$eval("#graph-log",el=>{el.value="100";el.dispatchEvent(new Event("input",{bubbles:true}));});
    const afterLog=await page.$eval("#curve",el=>el.toDataURL());
    assert.notEqual(beforeLog,afterLog,"display-axis slider must redraw the graph");
    await page.click("#curve");
    assert.match(await page.$eval("#graph-title",el=>el.textContent),/20kHz/);
    await page.$eval("#curve",el=>el.dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true})));
    assert.match(await page.$eval("#graph-title",el=>el.textContent),/0.001〜20Hz/);
    assert.equal(await page.$eval("#graph-log",el=>el.value),"100","subbass zoom uses logarithmic octave spacing");
    await page.$eval("#curve",el=>el.dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true})));
    assert.match(await page.$eval("#graph-title",el=>el.textContent),/2kHz/);
    await page.$eval("#axis-pivot",el=>{
      el.value="500";el.dispatchEvent(new Event("input",{bubbles:true}));
    });
    await page.$eval("#axis-slope",el=>{
      el.value="2";el.dispatchEvent(new Event("input",{bubbles:true}));
    });
    assert.match(await page.$eval("#listening-guide",el=>el.textContent),/500Hz →/);
    assert.match(await page.$eval("#coordinate-details",el=>el.textContent),/線形移動量/);
    // Signed physical slope and 0-convergence are genuine live WASM parameters.
    await page.$eval("#axis-pivot-value",el=>{el.value="350";el.dispatchEvent(new Event("input",{bubbles:true}));});
    for(const [slope,expected] of [[-1,200],[0,350],[-4,250],[1,500]]){
      await page.$eval("#axis-slope-value",(el,v)=>{el.value=String(v);el.dispatchEvent(new Event("input",{bubbles:true}));},slope);
      assert.equal(await page.$eval("#axis-slope-value",el=>Number(el.value)),slope);
      assert.match(await page.$eval("#listening-guide",el=>el.textContent),
        new RegExp("500Hz → "+expected+"Hz"),"signed slope geometry should reach shared Rust graph");
    }
    // Information is hidden until requested, available by pointer and keyboard.
    const contextHint=await page.$(".shape-control .info-tip summary");
    assert.ok(contextHint);
    await contextHint.click();
    assert.equal(await page.$eval(".shape-control .info-tip",el=>el.open),true);
    assert.match(await page.$eval(".shape-control .info-body",el=>el.textContent),/反転/);
    await contextHint.press("Enter");
    assert.equal(await page.$eval(".shape-control .info-tip",el=>el.open),false);
    assert.equal(await page.$eval("#crusher-bits",el=>el.closest(".fx-item").textContent.includes("量子化")),true);
    assert.equal(await page.$eval("#crusher-hold",el=>el.closest(".fx-item").textContent.includes("打刻速度")),true);
    await page.click("#slope-one");
    assert.equal(await page.$eval("#axis-slope",el=>Number(el.value)),1);
    await page.$eval("#axis-shift-value",el=>{
      el.value=".35";el.dispatchEvent(new Event("change",{bubbles:true}));
    });
    assert.equal(await page.$eval("#axis-shift",el=>Number(el.value)),.35);
    await page.click("#axis-zero");
    assert.equal(await page.$eval("#axis-shift-value",el=>Number(el.value)),0);

    await page.$eval("#curvature",el=>{el.value="0";el.dispatchEvent(new Event("input",{bubbles:true}));});
    await page.$eval("#axis-shift",el=>{el.value=".7";el.dispatchEvent(new Event("input",{bubbles:true}));});
    assert.match(await page.$eval("#axis-explainer",el=>el.textContent),/移動倍率 ×2/);
    assert.doesNotMatch(await page.$eval("#math-axis-note",el=>el.textContent),/準備中|未算出|計算中/);
    assert.match(await page.$eval("#math-axis-note",el=>el.textContent),/→/);
    await page.click("#axis-zero");
    assert.equal(await page.$eval("#axis-shift",el=>Number(el.value)),0);
    assert.equal(await page.$eval("#axis-shift-value",el=>Number(el.value)),0);
    await page.$eval("#curvature",el=>{el.value="1";el.dispatchEvent(new Event("input",{bubbles:true}));});

    assert.equal(await page.$eval("#math-results",el=>el.querySelectorAll("math").length),5);
    // Independent sine test can run before an audio file has been loaded.
    assert.equal(await page.$eval("#sine-hz",el=>Number(el.value)),440);
    await page.click("#sine-enabled");
    assert.equal(await page.$eval("#sine-enabled",el=>el.checked),true);
    await page.keyboard.down("Alt");
    await page.$eval("#sine-pitch",el=>{el.value="69.5";el.dispatchEvent(new Event("input",{bubbles:true}));});
    await page.keyboard.up("Alt");
    assert.match(await page.$eval("#sine-hz",el=>el.value),/452\.89/);
    assert.match(await page.$eval("#sine-cent",el=>el.value),/-50|50/);
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
    assert.match(await page.$eval("#math-variables",el=>el.textContent),/−|Δ/);
    await page.$eval("#carrier-range",el=>{el.value="1000";el.dispatchEvent(new Event("input",{bubbles:true}));});
    assert.equal(await page.$eval("#carrier",el=>Number(el.value)),20000);
    await page.$eval("#carrier-range",el=>{el.value="0";el.dispatchEvent(new Event("input",{bubbles:true}));});
    assert.equal(await page.$eval("#carrier",el=>Number(el.value)),0);
    await page.$eval("#carrier-range",el=>{el.value="592";el.dispatchEvent(new Event("input",{bubbles:true}));});
    await page.click("#ring-enabled");
    await page.select("#mode","fold-h");
    await page.click("#carrier-link");
    await page.waitForFunction(()=>document.querySelector("#carrier-linked-value").textContent.includes("Hz") &&
      document.querySelector("#carrier").disabled,{timeout:10000});
    const linked1=await page.$eval("#carrier-linked-value",el=>el.textContent);
    await page.$eval("#invert",el=>{el.value=".45";el.dispatchEvent(new Event("input",{bubbles:true}));});
    const linked2=await page.$eval("#carrier-linked-value",el=>el.textContent);
    assert.notEqual(linked1,linked2,"Fold location must change with invert parameter");
    assert.match(await page.$eval("#invert-reference-hz",el=>el.textContent),/Hz/);
    await page.select("#mode","reciprocal");
    assert.match(await page.$eval("#invert-reference-hz",el=>el.textContent),/反転固定点.*Hz/);
    assert.match(await page.$eval("#carrier-linked-value",el=>el.textContent),/連動対象なし/);
    await page.select("#mode","fold-h");
    assert.match(await page.$eval("#curvature-log-formula",el=>el.textContent),/ln/);
    assert.match(await page.$eval("#graph-log-formula",el=>el.textContent),/α=/);

    await page.click("#tab-map");
    // Emulate a Touch PointerEvent at iPhone 390px; verify a lower thumb
    // can be swiped without moving the upper synthesis value or overflow.
    await page.$eval("#reflection-dual",el=>{
      el.scrollIntoView({block:"center"});
      const inner=el.querySelector("[data-dual-inner]");
      const r=inner.getBoundingClientRect(),y=r.y+r.height-10;
      const fire=(type,fraction)=>el.dispatchEvent(new PointerEvent(type,{
        bubbles:true,pointerType:"touch",pointerId:91,isPrimary:true,
        clientX:r.x+fraction*r.width,clientY:y
      }));
      fire("pointerdown",0);fire("pointermove",.58);fire("pointerup",.58);
    });
    assert.ok(Math.abs(Number(await page.$eval("#zero-decay",e=>e.value))-58)<=2);
    assert.equal(await page.$eval("#zero-reflect",e=>e.value),"100");
    const mobileRail=await page.$eval("#reflection-dual",el=>{
      const b=el.getBoundingClientRect(),parent=el.closest(".quick-panel").getBoundingClientRect();
      return {x:b.x,right:b.right,parentRight:parent.right,height:b.height};
    });
    assert.ok(mobileRail.right<=mobileRail.parentRight+2 && mobileRail.height>=42,
      "iOS-sized dual-thumb must fit in controls "+JSON.stringify(mobileRail));
    await page.$eval("#zero-decay",el=>{el.value="0";el.dispatchEvent(new Event("input",{bubbles:true}));});
    assert.equal(await page.$eval("#view-map",el=>el.hidden),false);
    await page.click("#settings-open");
    assert.equal(await page.$eval("#settings-dialog",el=>el.open),true);
    assert.equal(await page.$eval("#engine-auto",el=>el.checked),false);
    // Graph-negative even WITHOUT raw invert: physical shift -700Hz and
    // target-0 Reflect turn the audible low band into a descending curve.
    // The manual B dropdown must be replaced by the true effective A label.
    await page.click("#settings-reset");
    await page.click("#engine-auto");
    for(const [id,value] of [["low-value","100"],["high-value","500"],
                              ["axis-pivot-value","350"],["axis-shift-value","-2"]]){
      await page.$eval("#"+id,(el,v)=>{
        el.value=v;el.dispatchEvent(new Event("change",{bubbles:true}));
      },value);
    }
    assert.match(await page.$eval("#engine-summary",el=>el.textContent),/^A /);
    assert.match(await page.$eval("#engine-auto-result",el=>el.textContent),/A /);
    assert.equal(await page.$eval("#engine",el=>el.hidden),true);
    assert.equal(await page.$eval("#engine-a-settings",el=>el.hidden),false);
    // 0-Hz policy is now a FRONT-PANEL reflected-amplitude slider; 0%
    // kills the branch, 100% reflects it, and mid settings are translucent.
    assert.equal(await page.$("#zero-mode"),null,"obsolete modal policy select removed");
    assert.equal(await page.$eval("#zero-reflect",el=>el.value),"100");
    const reflectedFull=await page.$eval("#curve",el=>el.toDataURL());
    await page.$eval("#zero-reflect",el=>{
      el.value="50";el.dispatchEvent(new Event("input",{bubbles:true}));
    });
    assert.match(await page.$eval("#zero-reflect-status",el=>el.textContent),/50%/);
    const reflectedHalf=await page.$eval("#curve",el=>el.toDataURL());
    assert.notEqual(reflectedFull,reflectedHalf,"reflected trajectory should become translucent at 50%");
    await page.$eval("#zero-reflect",el=>{
      el.value="0";el.dispatchEvent(new Event("input",{bubbles:true}));
    });
    assert.match(await page.$eval("#zero-reflect-status",el=>el.textContent),/合成 0%/);
    assert.match(await page.$eval("#engine-summary",el=>el.textContent),/^B /);
    assert.equal(await page.$eval("#engine-a-settings",el=>el.hidden),true);
    const reflectedKill=await page.$eval("#curve",el=>el.toDataURL());
    assert.notEqual(reflectedHalf,reflectedKill,"zero gain must remove reflected plot entirely");
    await page.$eval("#zero-reflect-value",el=>{
      el.value="100";el.dispatchEvent(new Event("change",{bubbles:true}));
    });
    assert.match(await page.$eval("#zero-reflect-status",el=>el.textContent),/合成 100% \/ 反射 0%/);
    assert.equal(await page.$eval("#zero-decay",el=>el.value),"0");
    await page.$eval("#zero-decay",el=>{
      el.value="50";el.dispatchEvent(new Event("input",{bubbles:true}));
    });
    assert.match(await page.$eval("#zero-reflect-status",el=>el.textContent),/反射 50%/);
    assert.match(await page.$eval("#zero-reflect-formula",el=>el.textContent),/350Hz/);
    const fadedGraph=await page.$eval("#curve",el=>el.toDataURL());
    assert.notEqual(reflectedFull,fadedGraph,"decay must change the drawn negative-target reflection");
    await page.$eval("#zero-decay",el=>{
      el.value="0";el.dispatchEvent(new Event("input",{bubbles:true}));
    });
    assert.equal(await page.$eval("#zero-reflect",el=>el.value),"100","falloff must not move the separate synthesis slider");
    assert.match(await page.$eval("#engine-summary",el=>el.textContent),/^A /);
    await page.click("#engine-auto");
    assert.match(await page.$eval("#engine-summary",el=>el.textContent),/^B /);
    assert.equal(await page.$eval("#engine",el=>el.hidden),false);
    // Restore the existing Ring/Rational integration scenario for the next
    // playback tests, without leaking the auto-curve probe into it.
    await page.select("#mode","fold-h");
    for(const id of ["ring-enabled","rational-enabled"]){
      await page.$eval("#"+id,el=>{
        el.checked=true;el.dispatchEvent(new Event("input",{bubbles:true}));
      });
    }
    for(const [id,v] of [["low-value","20"],["high-value","16000"],
                         ["axis-shift-value",".25"],["invert-value","45"]]){
      await page.$eval("#"+id,(el,value)=>{
        el.value=value;el.dispatchEvent(new Event("change",{bubbles:true}));
      },v);
    }

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
    // Simulate iOS file-picker return where audible AudioContext.resume()
    // never resolves. A first upload must still decode and enable play.
    await page.evaluate(()=>{
      window.__originalAudioResume=AudioContext.prototype.resume;
      AudioContext.prototype.resume=function(){return new Promise(()=>{});};
    });
    await (await page.$("#audio-file")).uploadFile(wavPath);
    await page.waitForFunction(()=>!document.querySelector("#play-wet").disabled,{timeout:20000});
    assert.match(await page.$eval("#status",el=>el.textContent),/読み込み完了/);
    await page.evaluate(()=>{
      AudioContext.prototype.resume=window.__originalAudioResume;
      delete window.__originalAudioResume;
    });

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
    // Dragging the actual reflected-rate thumb during live AudioWorklet
    // playback must go through the SAME Rust setter as the old range.
    await dragDual("reflection-dual",1,0,.36);
    assert.ok(Math.abs(Number(await page.$eval("#zero-decay",n=>n.value))-36)<=2);
    await page.waitForFunction(()=>document.querySelector("#rt-indicator").textContent.includes("操作反映済み"),{
      timeout:15000
    });
    await page.$eval("#zero-decay",n=>{n.value="0";n.dispatchEvent(new Event("input",{bubbles:true}));});
    await page.waitForFunction(()=>document.querySelector("#rt-indicator").textContent.includes("操作反映済み"),{
      timeout:15000
    });

    await page.$eval("#invert",node=>{
      node.value=".42";node.dispatchEvent(new Event("input",{bubbles:true}));
    });
    await page.waitForFunction(()=>document.querySelector("#rt-indicator").textContent.includes("操作反映済み"),
      {timeout:15000});
    // Switch actual Rust DSP engines via the discoverable SETTINGS dialog.
    await page.click(".fx-more summary");
    await page.click("#rational-enabled");
    await page.click("#settings-open");
    // Ring and rational layout are *effects*, not synthesis engines.
    assert.deepEqual(await page.evaluate(()=>Array.from(document.querySelectorAll("#engine option:not(:disabled)")).map(n=>n.value)),["0","1"]);
    assert.match(await page.$eval("#engine-description",el=>el.textContent),/Ring Mod/);
    await page.waitForFunction(()=>document.querySelector("#rt-indicator").textContent.includes("操作反映済み"),{timeout:25000});
    await page.select("#engine","0");
    assert.equal(await page.$eval("#engine-a-settings",el=>el.hidden),false);
    await page.$eval("#a-min",el=>{el.value="570";el.dispatchEvent(new Event("input",{bubbles:true}));});
    assert.ok(await page.$eval("#a-min-value",el=>Number(el.value))>100);
    await page.$eval("#a-band",el=>{el.value="6";el.dispatchEvent(new Event("input",{bubbles:true}));});
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
    assert.match(await page.$eval("#crusher-alias-note",el=>el.textContent),/y=.*Hz/);
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
    const soughtSeconds=await page.$eval("#elapsed",el=>{
      const [m,sec]=el.textContent.split(":").map(Number);
      return m*60+sec;
    });
    assert.ok(Math.abs(soughtSeconds-540)<3,
      "600s waveform seek should land near 9:00, got "+soughtSeconds);
    await page.click("#stop");
    // Reproduce a cold iOS decoder that never settles on its first path.
    // The first file selection on a NEW page must recover on its own.
    const coldPage=await browser.newPage();
    await coldPage.goto("http://127.0.0.1:8765/index.html");
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
