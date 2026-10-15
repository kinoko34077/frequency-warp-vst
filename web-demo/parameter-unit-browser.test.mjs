/** #79 M1: exercise the staged, actual Web GUI (not a mocked unit widget).
 * This test uses the exact _site closure, the existing audio/graph modules and
 * a 390px mobile viewport. It intentionally avoids altering native VST3.
 */
import {test} from "node:test";
import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {resolve} from "node:path";
import puppeteer from "puppeteer-core";

const sleep=ms=>new Promise(r=>setTimeout(r,ms));
test("low Hz / note+cents / true rail% / optional snap / invalid and reset",async()=>{
  const server=spawn("python3",["-m","http.server","8774","--bind","127.0.0.1"],{
    cwd:resolve(process.env.WARP_WEB_ROOT||"_site"),stdio:"ignore"
  });
  let browser;
  try {
    browser=await puppeteer.launch({
      executablePath:process.env.CHROME_BIN||"/usr/bin/google-chrome",
      headless:true,args:["--no-sandbox","--disable-dev-shm-usage"]
    });
    const page=await browser.newPage();
    await page.setViewport({width:390,height:844,deviceScaleFactor:2,isMobile:true,hasTouch:true});
    const errors=[];
    page.on("pageerror",e=>errors.push(String(e.message)));
    let started=false;
    for(let i=0;i<30;i++){
      try {
        const response=await page.goto("http://127.0.0.1:8774/index.html",{waitUntil:"domcontentloaded"});
        if(response?.ok()){started=true;break;}
      }catch{}
      await sleep(250);
    }
    assert.ok(started,"staged Web app HTTP server not ready");
    await page.waitForFunction(()=>document.documentElement.dataset.fwBoot==="ready",{timeout:18000});
    assert.deepEqual(await page.$$eval("#low-unit option",options=>options.map(o=>o.value)),["hz","note","percent"]);
    assert.equal(await page.$eval("#low-unit",el=>el.value),"hz");
    assert.equal(await page.$eval("#low-snap",el=>el.checked),false);
    const selectorVisible=await page.$eval("#low-unit",el=>el.getBoundingClientRect().height>0);
    assert.equal(selectorVisible,true,"unit dropdown hidden at mobile width");

    // Existing start at L=20Hz. A unit-only view change must not change L.
    const original=await page.$eval("#low",el=>el.value);
    await page.select("#low-unit","note");
    assert.match(await page.$eval("#low-value",el=>el.value),/^[A-G](#)?-?\d/);
    assert.equal(await page.$eval("#low",el=>el.value),original);

    // Actual musical note input becomes a full-precision canonical Hz value.
    await page.$eval("#low-value",el=>{
      el.value="A4+25c";el.dispatchEvent(new Event("input",{bubbles:true}));
    });
    await page.select("#low-unit","hz");
    await page.focus("#low-value");
    const exact=Number(await page.$eval("#low-value",el=>el.value));
    assert.ok(Math.abs(exact-440*2**(25/1200))<1e-9,"full precision note conversion: "+exact);
    await page.$eval("#low-value",el=>el.blur());

    // % means its actual piecewise logarithmic thumb rail, not f/20000.
    await page.select("#low-unit","percent");
    const pct=Number(await page.$eval("#low-value",el=>el.value));
    const expected=100*(.2+.8*Math.log(exact/20)/Math.log(1000));
    assert.ok(Math.abs(pct-expected)<.01,"nonlinear percent: "+pct+" expected "+expected);
    await page.$eval("#low-value",el=>{
      el.value="50";el.dispatchEvent(new Event("input",{bubbles:true}));
    });
    await page.select("#low-unit","hz");
    await page.focus("#low-value");
    const half=Number(await page.$eval("#low-value",el=>el.value));
    assert.ok(Math.abs(half-(20*Math.exp(Math.log(1000)*(.5-.2)/.8)))<1e-8);

    // Invalid musical text must never turn the current accepted DSP value to zero.
    await page.$eval("#low-value",el=>el.blur());
    await page.select("#low-unit","note");
    await page.$eval("#low-value",el=>{
      el.value="INVALID";el.dispatchEvent(new Event("input",{bubbles:true}));
      el.dispatchEvent(new Event("change",{bubbles:true}));
    });
    await page.select("#low-unit","hz");
    await page.focus("#low-value");
    assert.ok(Math.abs(Number(await page.$eval("#low-value",el=>el.value))-half)<1e-8);

    // Snap is explicitly opt-in and uses the same source rail as dual thumbs.
    await page.$eval("#low-value",el=>el.blur());
    await page.$eval("#low-snap",el=>{el.checked=true;el.dispatchEvent(new Event("change",{bubbles:true}));});
    const railStep=Math.round(200+800*Math.log(440/20)/Math.log(1000));
    await page.$eval("#low", (el,step)=>{
      el.value=String(step);el.dispatchEvent(new Event("input",{bubbles:true}));
    },railStep);
    await page.focus("#low-value");
    assert.ok(Math.abs(Number(await page.$eval("#low-value",el=>el.value))-440)<1e-8,
      "opt-in semitone snap must land exactly on A4 440 Hz");
    assert.equal(await page.$eval("#low-thumb",el=>el.getAttribute("aria-valuetext")),"440 Hz",
      "accessible physical tooltip must reflect snapped canonical DSP Hz");
    await page.$eval("#low-value",el=>el.blur());

    // Existing keyboard accessible thumb path must continue to emit native input.
    await page.focus("#low-thumb");
    await page.keyboard.press("ArrowRight");
    assert.ok(Number(await page.$eval("#low",el=>el.value))>=railStep);

    // Upper H is a second independent binding with the same unit registry.
    assert.deepEqual(await page.evaluate(()=>[...document.querySelectorAll("#high-unit option")].map(i=>i.value)),
      ["hz","note","percent"]);
    assert.equal(await page.$eval("#high-snap",el=>el.checked),false);
    const highRailInitial=await page.$eval("#high",el=>el.value);
    await page.select("#high-unit","note");
    assert.equal(await page.$eval("#high",el=>el.value),highRailInitial,
      "H unit-only changes must not update the DSP value");
    await page.$eval("#high-value",el=>{
      el.value="A5+25c";el.dispatchEvent(new Event("input",{bubbles:true}));
    });
    await page.select("#high-unit","hz");
    await page.focus("#high-value");
    const highExact=Number(await page.$eval("#high-value",el=>el.value));
    assert.ok(Math.abs(highExact-880*2**(25/1200))<1e-9);
    await page.$eval("#high-value",el=>el.blur());
    await page.select("#high-unit","percent");
    const highPercent=Number(await page.$eval("#high-value",el=>el.value));
    const expectedHighPercent=100*(.2+.8*Math.log(highExact/20)/Math.log(1000));
    assert.ok(Math.abs(highPercent-expectedHighPercent)<.01);
    await page.select("#high-unit","note");
    await page.$eval("#high-value",el=>{
      el.value="invalid";el.dispatchEvent(new Event("input",{bubbles:true}));
      el.dispatchEvent(new Event("change",{bubbles:true}));
    });
    await page.select("#high-unit","hz");
    await page.focus("#high-value");
    assert.ok(Math.abs(Number(await page.$eval("#high-value",el=>el.value))-highExact)<1e-9);
    await page.$eval("#high-value",el=>el.blur());

    // H opt-in snap and keyboard gestures are a peer, not a new DSP path.
    await page.$eval("#high-snap",el=>{el.checked=true;});
    const highStep=Math.round(200+800*Math.log(880/20)/Math.log(1000));
    await page.$eval("#high",(el,step)=>{
      el.value=String(step);el.dispatchEvent(new Event("input",{bubbles:true}));
    },highStep);
    await page.focus("#high-value");
    assert.ok(Math.abs(Number(await page.$eval("#high-value",el=>el.value))-880)<1e-8);
    await page.$eval("#high-value",el=>el.blur());
    assert.equal(await page.$eval("#high-thumb",el=>el.getAttribute("aria-valuetext")),"880 Hz");

    // P is a distinct physical frequency; zero is a special valid state
    // with no musical-note representation, and note selection must recover.
    assert.equal(await page.$eval("#pivot-unit",el=>el.value),"hz");
    assert.equal(await page.$eval("#pivot-snap",el=>el.checked),false);
    await page.select("#pivot-unit","note");
    await page.$eval("#axis-pivot-value",el=>{
      el.value="A4+25c";el.dispatchEvent(new Event("input",{bubbles:true}));
    });
    await page.select("#pivot-unit","hz");
    await page.focus("#axis-pivot-value");
    const pivotExact=Number(await page.$eval("#axis-pivot-value",el=>el.value));
    assert.ok(Math.abs(pivotExact-440*2**(25/1200))<1e-9);
    await page.$eval("#axis-pivot-value",el=>el.blur());
    await page.select("#pivot-unit","percent");
    const pivotPct=Number(await page.$eval("#axis-pivot-value",el=>el.value));
    const expectedPivotPct=100*(.2+.8*Math.log(pivotExact/20)/Math.log(1000));
    assert.ok(Math.abs(pivotPct-expectedPivotPct)<.01);
    await page.select("#pivot-unit","note");
    await page.$eval("#axis-pivot",el=>{
      el.value="0";el.dispatchEvent(new Event("input",{bubbles:true}));
    });
    assert.equal(await page.$eval("#pivot-unit",el=>el.value),"hz",
      "zero pivot must revert musical-note view to Hz");
    assert.equal(await page.$eval("#axis-pivot-value",el=>Number(el.value)),0);
    await page.select("#pivot-unit","note");
    assert.equal(await page.$eval("#pivot-unit",el=>el.value),"hz",
      "do not permit converting the physically meaningful 0Hz into a note");

    // Existing opt-in harmonic link remains bidirectional after P migration.
    await page.click(".harmonic-pivot-link");
    assert.equal(await page.$eval("#harmonic-pivot-link",el=>el.checked),true);
    await page.select("#pivot-unit","note");
    await page.$eval("#axis-pivot-value",el=>{
      el.value="A3";el.dispatchEvent(new Event("input",{bubbles:true}));
    });
    assert.ok(Math.abs(Number(await page.$eval("#fundamental",el=>el.value))-880)<.005,
      "P=220Hz with m=4 and r=1 must solve F=880Hz");
    await page.select("#pivot-unit","hz");
    await page.$eval("#axis-pivot-value",el=>el.blur());

    // M1 fundamental F: same unit registry, a linear 20..2000Hz slider,
    // and one shared canonical value feeding the existing harmonic math.
    await page.click("#tab-math");
    assert.deepEqual(await page.evaluate(()=>Array.from(document.querySelectorAll("#fundamental-unit option"),item=>item.value)),
      ["hz","note","percent"]);
    assert.equal(await page.$eval("#fundamental-snap",el=>el.checked),false);
    const existingLinkedP=Number(await page.$eval("#axis-pivot-value",el=>el.value));
    await page.select("#fundamental-unit","note");
    assert.ok(Math.abs(Number(await page.$eval("#axis-pivot-value",el=>el.value))-existingLinkedP)<.001,
      "unit-only F change must not alter linked pivot P");

    await page.$eval("#fundamental",el=>{
      el.value="A4+25c";el.dispatchEvent(new Event("input",{bubbles:true}));
    });
    await page.select("#fundamental-unit","hz");
    await page.focus("#fundamental");
    const preciseF=Number(await page.$eval("#fundamental",el=>el.value));
    assert.ok(Math.abs(preciseF-440*2**(25/1200))<1e-9);
    assert.ok(Math.abs(Number(await page.$eval("#axis-pivot-value",el=>el.value))-preciseF/4)<.002,
      "F with H link ON must update P=F/4");
    await page.$eval("#fundamental",el=>el.blur());
    await page.select("#fundamental-unit","percent");
    assert.ok(Math.abs(Number(await page.$eval("#fundamental",el=>el.value))-
      100*(preciseF-20)/1980)<.01,"F rail% is physical linear travel");
    await page.$eval("#fundamental",el=>{
      el.value="50";el.dispatchEvent(new Event("input",{bubbles:true}));
    });
    await page.select("#fundamental-unit","hz");
    await page.focus("#fundamental");
    assert.equal(await page.$eval("#fundamental",el=>Number(el.value)),1010);
    assert.ok(Math.abs(Number(await page.$eval("#axis-pivot-value",el=>el.value))-252.5)<.002);
    await page.$eval("#fundamental",el=>el.blur());

    await page.select("#fundamental-unit","note");
    await page.$eval("#fundamental",el=>{
      el.value="INVALID";el.dispatchEvent(new Event("input",{bubbles:true}));
      el.dispatchEvent(new Event("change",{bubbles:true}));
    });
    await page.select("#fundamental-unit","hz");
    await page.focus("#fundamental");
    assert.equal(await page.$eval("#fundamental",el=>Number(el.value)),1010);
    await page.$eval("#fundamental",el=>el.blur());

    await page.$eval("#fundamental-snap",el=>{el.checked=true;});
    await page.$eval("#fundamental-range",el=>{
      el.value="440";el.dispatchEvent(new Event("input",{bubbles:true}));
    });
    await page.focus("#fundamental");
    assert.equal(await page.$eval("#fundamental",el=>Number(el.value)),440);
    assert.ok(Math.abs(Number(await page.$eval("#axis-pivot-value",el=>el.value))-110)<.002);
    await page.$eval("#fundamental",el=>el.blur());

    // The reverse P -> F path must no longer lose fractional cents.
    await page.select("#pivot-unit","note");
    await page.$eval("#axis-pivot-value",el=>{
      el.value="A3+25c";el.dispatchEvent(new Event("input",{bubbles:true}));
    });
    await page.focus("#fundamental");
    assert.ok(Math.abs(Number(await page.$eval("#fundamental",el=>el.value))-
      4*220*2**(25/1200))<1e-9,"linked P→F must retain full precision");
    await page.$eval("#fundamental",el=>el.blur());
    await page.select("#pivot-unit","hz");

    // Carrier c: distinct exact 0Hz rail, typed positive sub-1Hz, and
    // per-unit musical snap. Do not modify the linked fold output policy.
    await page.click("#tab-map");
    await page.$eval("#ring-enabled",el=>{
      el.checked=true;el.dispatchEvent(new Event("input",{bubbles:true}));
    });
    assert.deepEqual(await page.evaluate(()=>
      Array.from(document.querySelectorAll("#carrier-unit option"),el=>el.value)),
      ["hz","note","percent"]);
    assert.equal(await page.$eval("#carrier-snap",el=>el.checked),false);
    const beforeUnitCarrier=await page.$eval("#carrier-range",el=>el.value);
    await page.select("#carrier-unit","note");
    assert.equal(await page.$eval("#carrier-range",el=>el.value),beforeUnitCarrier,
      "carrier view-only change must not move slider/DSP");
    await page.$eval("#carrier",el=>{
      el.value="A4+25c";el.dispatchEvent(new Event("input",{bubbles:true}));
    });
    await page.select("#carrier-unit","hz");
    await page.focus("#carrier");
    const exactCarrier=Number(await page.$eval("#carrier",el=>el.value));
    assert.ok(Math.abs(exactCarrier-440*2**(25/1200))<1e-9);
    await page.$eval("#carrier",el=>el.blur());
    await page.select("#carrier-unit","percent");
    const carrierPercent=Number(await page.$eval("#carrier",el=>el.value));
    const expectedCarrierPercent=(1+999*Math.log(exactCarrier)/Math.log(20000))/10;
    assert.ok(Math.abs(carrierPercent-expectedCarrierPercent)<.01);
    // Sub-1Hz is continuous canonically, even if the physical thumb is 1-step coarse.
    await page.$eval("#carrier",el=>{
      el.value="0.05";el.dispatchEvent(new Event("input",{bubbles:true}));
    });
    await page.select("#carrier-unit","hz");
    await page.focus("#carrier");
    assert.ok(Math.abs(Number(await page.$eval("#carrier",el=>el.value))-.5)<1e-8,
      "0.05% carrier rail must map to 0.5Hz");
    await page.$eval("#carrier",el=>el.blur());
    await page.select("#carrier-unit","note");
    await page.$eval("#carrier-range",el=>{
      el.value="0";el.dispatchEvent(new Event("input",{bubbles:true}));
    });
    assert.equal(await page.$eval("#carrier",el=>Number(el.value)),0);
    assert.equal(await page.$eval("#carrier-unit",el=>el.value),"hz",
      "0Hz carrier cannot display a fabricated musical note");

    await page.$eval("#carrier-snap",el=>{el.checked=true;});
    const carrierA4Step=Math.round(1+999*Math.log(440)/Math.log(20000));
    await page.$eval("#carrier-range",(el,step)=>{
      el.value=String(step);el.dispatchEvent(new Event("input",{bubbles:true}));
    },carrierA4Step);
    await page.focus("#carrier");
    assert.ok(Math.abs(Number(await page.$eval("#carrier",el=>el.value))-440)<1e-8,
      "carrier slider note snap must land on A4");
    await page.$eval("#carrier",el=>el.blur());

    await page.select("#mode","fold-h");
    await page.$eval("#carrier-link",el=>{
      el.checked=true;el.dispatchEvent(new Event("change",{bubbles:true}));
    });
    assert.equal(await page.$eval("#carrier-unit",el=>el.disabled),true);
    assert.equal(await page.$eval("#carrier-snap",el=>el.disabled),true);
    assert.match(await page.$eval("#carrier-linked-value",el=>el.textContent),/連動/);
    await page.$eval("#carrier-link",el=>{
      el.checked=false;el.dispatchEvent(new Event("change",{bubbles:true}));
    });
    assert.equal(await page.$eval("#carrier-unit",el=>el.disabled),false);

    await page.click("#settings-open");
    await page.click("#settings-reset");
    assert.equal(await page.$eval("#carrier-unit",el=>el.value),"hz");
    assert.equal(await page.$eval("#carrier-snap",el=>el.checked),false);
    assert.equal(await page.$eval("#carrier",el=>Number(el.value)),350);
    assert.equal(await page.$eval("#fundamental-unit",el=>el.value),"hz");
    assert.equal(await page.$eval("#fundamental-snap",el=>el.checked),false);
    assert.equal(await page.$eval("#fundamental",el=>Number(el.value)),350);
    assert.equal(await page.$eval("#pivot-unit",el=>el.value),"hz");
    assert.equal(await page.$eval("#pivot-snap",el=>el.checked),false);
    assert.equal(await page.$eval("#axis-pivot-value",el=>Number(el.value)),350);
    assert.equal(await page.$eval("#harmonic-pivot-link",el=>el.checked),false);
    assert.equal(await page.$eval("#high-unit",el=>el.value),"hz");
    assert.equal(await page.$eval("#high-snap",el=>el.checked),false);
    assert.equal(await page.$eval("#high-value",el=>Number(el.value)),16000);
    assert.equal(await page.$eval("#low-unit",el=>el.value),"hz");
    assert.equal(await page.$eval("#low-snap",el=>el.checked),false);
    assert.equal(await page.$eval("#low-value",el=>Number(el.value)),20);
    assert.equal(await page.$eval("#low",el=>el.value),"200");
    assert.deepEqual(errors,[],"browser JS errors: "+errors.join("; "));
  }finally {
    await browser?.close();
    server.kill();
  }
});
