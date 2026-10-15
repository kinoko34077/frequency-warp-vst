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
    assert.equal(await page.$eval("#low",el=>el.dataset.fwSnap),"on");
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

    // Snap is ON by default and uses the same source rail as dual thumbs.
    await page.$eval("#low-value",el=>el.blur());
    const railStep=Math.round(200+800*Math.log(440/20)/Math.log(1000));
    await page.$eval("#low", (el,step)=>{
      el.value=String(step);el.dispatchEvent(new Event("input",{bubbles:true}));
    },railStep);
    await page.focus("#low-value");
    assert.ok(Math.abs(Number(await page.$eval("#low-value",el=>el.value))-440)<1e-8,
      "default-on semitone snap must land exactly on A4 440 Hz");
    assert.equal(await page.$eval("#low-thumb",el=>el.getAttribute("aria-valuetext")),"440 Hz",
      "accessible physical tooltip must reflect snapped canonical DSP Hz");
    await page.$eval("#low-value",el=>el.blur());

    // No permanent toggle: context menus own the per-control snap state.
    assert.equal(await page.$eval(".snap-toggle",el=>el!==null).catch(()=>false),false,
      "permanent snap checkboxes are removed");
    await page.$eval("#low-thumb",el=>el.dispatchEvent(new MouseEvent("contextmenu",{
      bubbles:true,cancelable:true,clientX:60,clientY:120
    })));
    assert.equal(await page.$eval("#fw-unit-snap-menu",el=>el.hidden),false);
    assert.match(await page.$eval("#fw-unit-snap-menu button",el=>el.textContent),/オフ/);
    await page.$eval("#fw-unit-snap-menu button",el=>el.click());
    assert.equal(await page.$eval("#low",el=>el.dataset.fwSnap),"off");
    await page.$eval("#low",(el,step)=>{
      el.value=String(step);el.dispatchEvent(new Event("input",{bubbles:true}));
    },railStep);
    await page.focus("#low-value");
    assert.ok(Math.abs(Number(await page.$eval("#low-value",el=>el.value))-440)>.05,
      "manual snap OFF preserves the coarse physical slider frequency");
    await page.$eval("#low-value",el=>el.blur());
    // Keyboard context menu works without a mouse and can turn snap back ON.
    await page.focus("#low-value");
    await page.keyboard.down("Shift");await page.keyboard.press("F10");await page.keyboard.up("Shift");
    assert.equal(await page.$eval("#fw-unit-snap-menu",el=>el.hidden),false);
    await page.$eval("#fw-unit-snap-menu button",el=>el.click());
    assert.equal(await page.$eval("#low",el=>el.dataset.fwSnap),"on");
    // Holding either Ctrl or Alt bypasses snapping for that gesture only.
    for(const modifier of ["Alt","Control"]){
      await page.keyboard.down(modifier);
      await page.$eval("#low",(el,step)=>{
        el.value=String(step);el.dispatchEvent(new Event("input",{bubbles:true}));
      },railStep);
      await page.keyboard.up(modifier);
      await page.focus("#low-value");
      assert.ok(Math.abs(Number(await page.$eval("#low-value",el=>el.value))-440)>.05,
        modifier+" must temporarily bypass ON snapping");
      await page.$eval("#low-value",el=>el.blur());
    }
    await page.$eval("#low",(el,step)=>{
      el.value=String(step);el.dispatchEvent(new Event("input",{bubbles:true}));
    },railStep);
    await page.focus("#low-value");
    assert.ok(Math.abs(Number(await page.$eval("#low-value",el=>el.value))-440)<1e-8);
    await page.$eval("#low-value",el=>el.blur());
    // Fractional cents are parsed and preserved, but shown as whole cents.
    await page.select("#low-unit","note");
    await page.$eval("#low-value",el=>{
      el.value="A4+25.375c";el.dispatchEvent(new Event("input",{bubbles:true}));
    });
    await page.$eval("#low-value",el=>el.blur());
    assert.equal(await page.$eval("#low-value",el=>el.value),"A4+25c");
    await page.focus("#low-value");
    assert.equal(await page.$eval("#low-value",el=>el.value),"A4+25c",
      "focus must not reveal fractional cents");
    await page.select("#low-unit","hz");
    // Puppeteer's select() dispatches change without focusing the select.
    // Explicitly blur and refocus to expose the full canonical Hz editor.
    await page.$eval("#low-value",el=>el.blur());
    await page.focus("#low-value");
    const recoveredLow=Number(await page.$eval("#low-value",el=>el.value));
    assert.ok(Math.abs(recoveredLow-440*2**(25.375/1200))<1e-9,
      "hidden fractional cents remain canonical; actual "+recoveredLow+
      " vs expected "+(440*2**(25.375/1200)));
    await page.$eval("#low-value",el=>el.blur());

    // Existing keyboard accessible thumb path must continue to emit native input.
    await page.focus("#low-thumb");
    await page.keyboard.press("ArrowRight");
    assert.ok(Number(await page.$eval("#low",el=>el.value))>=railStep);

    // Upper H is a second independent binding with the same unit registry.
    assert.deepEqual(await page.evaluate(()=>[...document.querySelectorAll("#high-unit option")].map(i=>i.value)),
      ["hz","note","percent"]);
    assert.equal(await page.$eval("#high",el=>el.dataset.fwSnap),"on");
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

    // H default-on snap and keyboard gestures are a peer, not a new DSP path.
    const highStep=Math.round(200+800*Math.log(880/20)/Math.log(1000));
    await page.$eval("#high",(el,step)=>{
      el.value=String(step);el.dispatchEvent(new Event("input",{bubbles:true}));
    },highStep);
    await page.focus("#high-value");
    assert.ok(Math.abs(Number(await page.$eval("#high-value",el=>el.value))-880)<1e-8);
    await page.$eval("#high-value",el=>el.blur());
    assert.equal(await page.$eval("#high-thumb",el=>el.getAttribute("aria-valuetext")),"880 Hz");
    // A touch long press opens the same toggle menu (without any button).
    await page.$eval("#high-value",el=>{
      el.dispatchEvent(new PointerEvent("pointerdown",{
        bubbles:true,pointerId:718,pointerType:"touch",isPrimary:true,button:0,
        clientX:48,clientY:90
      }));
    });
    await sleep(610);
    assert.equal(await page.$eval("#fw-unit-snap-menu",el=>el.hidden),false);
    await page.$eval("#high-value",el=>{
      el.dispatchEvent(new PointerEvent("pointerup",{
        bubbles:true,pointerId:718,pointerType:"touch",isPrimary:true,button:0
      }));
    });
    await page.$eval("#fw-unit-snap-menu button",el=>el.click());
    assert.equal(await page.$eval("#high",el=>el.dataset.fwSnap),"off");
    await page.$eval("#high-value",el=>el.dispatchEvent(new MouseEvent("contextmenu",{
      bubbles:true,cancelable:true,clientX:60,clientY:115
    })));
    await page.$eval("#fw-unit-snap-menu button",el=>el.click());
    assert.equal(await page.$eval("#high",el=>el.dataset.fwSnap),"on");

    // P is a distinct physical frequency; zero is a special valid state
    // with no musical-note representation, and note selection must recover.
    assert.equal(await page.$eval("#pivot-unit",el=>el.value),"hz");
    assert.equal(await page.$eval("#axis-pivot",el=>el.dataset.fwSnap),"on");
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

    // F is now the harmonic panel's one canonical number; its slider is
    // linear rather than logarithmic, and linked H/P uses this same value.
    await page.click("#tab-math");
    assert.equal(await page.$eval("#fundamental-unit",el=>el.getBoundingClientRect().height>0),true);
    assert.equal(await page.$eval("#fundamental-range",el=>el.dataset.fwSnap),"on");
    await page.select("#fundamental-unit","note");
    await page.$eval("#fundamental",el=>{
      el.value="A4+25c";el.dispatchEvent(new Event("input",{bubbles:true}));
    });
    await page.select("#fundamental-unit","hz");
    await page.focus("#fundamental");
    const fExact=Number(await page.$eval("#fundamental",el=>el.value));
    assert.ok(Math.abs(fExact-440*2**(25/1200))<1e-9);
    await page.$eval("#fundamental",el=>el.blur());
    await page.select("#fundamental-unit","percent");
    assert.ok(Math.abs(Number(await page.$eval("#fundamental",el=>el.value))-
      100*(fExact-20)/1980)<.01, "F percent must follow its LINEAR rail");
    await page.select("#fundamental-unit","hz");
    await page.focus("#fundamental");
    assert.ok(Math.abs(Number(await page.$eval("#fundamental",el=>el.value))-fExact)<1e-9);
    await page.$eval("#fundamental",el=>el.blur());
    // The preexisting opt-in H/P link remains tied to the precise F.
    const linkedPivot=Number(await page.$eval("#axis-pivot-value",el=>el.value));
    assert.ok(Math.abs(linkedPivot-fExact/4)<.005,
      "harmonic H/P link must read shared exact F");
    await page.$eval("#fundamental-range",el=>{
      el.value="440";el.dispatchEvent(new Event("input",{bubbles:true}));
    });
    await page.focus("#fundamental");
    assert.equal(Number(await page.$eval("#fundamental",el=>el.value)),440);
    await page.$eval("#fundamental",el=>el.blur());
    assert.ok(Math.abs(Number(await page.$eval("#axis-pivot-value",el=>el.value))-110)<.005);
    await page.select("#fundamental-unit","note");
    await page.$eval("#fundamental",el=>{
      el.value="invalid";el.dispatchEvent(new Event("change",{bubbles:true}));
    });
    await page.select("#fundamental-unit","hz");
    await page.focus("#fundamental");
    assert.equal(Number(await page.$eval("#fundamental",el=>el.value)),440);
    await page.$eval("#fundamental",el=>el.blur());
    // Signed slope s is a dimensionless orientation/scale, not a musical
    // frequency or semitone interval. Its real rail is -4..+4 linearly.
    assert.deepEqual(await page.evaluate(()=>[...document.querySelectorAll(
      "#axis-slope-unit option")].map(el=>el.value)),["ratio","percent"]);
    assert.equal(await page.$eval("#axis-slope",el=>el.dataset.fwSnap),"on");
    const slopeRailInitial=await page.$eval("#axis-slope",el=>el.value);
    await page.select("#axis-slope-unit","percent");
    assert.equal(await page.$eval("#axis-slope",el=>el.value),slopeRailInitial);
    assert.equal(Number(await page.$eval("#axis-slope-value",el=>el.value)),62.5);
    await page.$eval("#axis-slope-value",el=>{
      el.value="25";el.dispatchEvent(new Event("input",{bubbles:true}));
    });
    await page.select("#axis-slope-unit","ratio");
    await page.focus("#axis-slope-value");
    assert.equal(Number(await page.$eval("#axis-slope-value",el=>el.value)),-2);
    await page.$eval("#axis-slope-value",el=>el.blur());
    await page.$eval("#axis-slope-value",el=>{
      el.value="-1.25";el.dispatchEvent(new Event("change",{bubbles:true}));
    });
    await page.focus("#axis-slope-value");
    assert.equal(Number(await page.$eval("#axis-slope-value",el=>el.value)),-1.25);
    await page.$eval("#axis-slope-value",el=>el.blur());
    for(const [thumb,target] of [["-.98",-1],[".02",0],[".98",1]]){
      await page.$eval("#axis-slope",(el,t)=>{
        el.value=t;el.dispatchEvent(new Event("input",{bubbles:true}));
      },thumb);
      await page.focus("#axis-slope-value");
      assert.equal(Number(await page.$eval("#axis-slope-value",el=>el.value)),target,
        "snap actual signed scale to -1/0/+1");
      await page.$eval("#axis-slope-value",el=>el.blur());
    }
    await page.$eval("#axis-slope-value",el=>{
      el.value="C4";el.dispatchEvent(new Event("change",{bubbles:true}));
    });
    await page.focus("#axis-slope-value");
    assert.equal(Number(await page.$eval("#axis-slope-value",el=>el.value)),1,
      "signed slope never parses a musical note name");
    await page.$eval("#axis-slope-value",el=>el.blur());
    await page.click("#slope-one");
    assert.equal(await page.$eval("#axis-slope-value",el=>Number(el.value)),1);

    // M2 positive ratio r: its units are intervals, NOT absolute note Hz.
    const initialRThumb=await page.$eval("#pitch-ratio-range",el=>el.value);
    assert.deepEqual(await page.evaluate(()=>[...document.querySelectorAll(
      "#pitch-ratio-unit option")].map(el=>el.value)),
      ["ratio","semitones","cents","percent"]);
    assert.equal(await page.$eval("#pitch-ratio-range",el=>el.dataset.fwSnap),"on");
    await page.select("#pitch-ratio-unit","semitones");
    assert.equal(await page.$eval("#pitch-ratio-range",el=>el.value),initialRThumb,
      "view-only changes must preserve the source ratio and DSP");
    await page.$eval("#pitch-ratio",el=>{
      el.value="7";el.dispatchEvent(new Event("input",{bubbles:true}));
    });
    await page.select("#pitch-ratio-unit","ratio");
    await page.focus("#pitch-ratio");
    const ratioExact=Number(await page.$eval("#pitch-ratio",el=>el.value));
    assert.ok(Math.abs(ratioExact-2**(7/12))<1e-12);
    await page.$eval("#pitch-ratio",el=>el.blur());
    await page.select("#pitch-ratio-unit","cents");
    assert.ok(Math.abs(Number(await page.$eval("#pitch-ratio",el=>el.value))-700)<.001);
    // Relative cent fields accept decimals while hiding them on display.
    await page.$eval("#pitch-ratio",el=>{
      el.value="700.375";el.dispatchEvent(new Event("input",{bubbles:true}));
    });
    await page.$eval("#pitch-ratio",el=>el.blur());
    assert.equal(await page.$eval("#pitch-ratio",el=>el.value),"700");
    await page.select("#pitch-ratio-unit","ratio");
    await page.focus("#pitch-ratio");
    assert.ok(Math.abs(Number(await page.$eval("#pitch-ratio",el=>el.value))-
      2**(7.00375/12))<1e-12);
    await page.$eval("#pitch-ratio",el=>el.blur());
    // Restore the round-number case used by the existing link contract.
    await page.select("#pitch-ratio-unit","semitones");
    await page.$eval("#pitch-ratio",el=>{
      el.value="7";el.dispatchEvent(new Event("input",{bubbles:true}));
    });
    await page.select("#pitch-ratio-unit","cents");
    await page.select("#pitch-ratio-unit","percent");
    assert.ok(Math.abs(Number(await page.$eval("#pitch-ratio",el=>el.value))-
      100*(ratioExact-.25)/3.75)<.01, "ratio% uses the physical linear rail");
    assert.ok(Math.abs(Number(await page.$eval("#axis-pivot-value",el=>el.value))-
      ratioExact*440/4)<.001, "r edit still updates linked P");
    await page.select("#pitch-ratio-unit","ratio");
    await page.$eval("#pitch-ratio",el=>{
      el.value="1";el.dispatchEvent(new Event("input",{bubbles:true}));
    });
    await page.$eval("#pitch-ratio-range",el=>{
      el.value="1.05";el.dispatchEvent(new Event("input",{bubbles:true}));
    });
    await page.focus("#pitch-ratio");
    assert.ok(Math.abs(Number(await page.$eval("#pitch-ratio",el=>el.value))-
      2**(1/12))<1e-12, "physical-pixel snap targets one interval semitone");
    await page.$eval("#pitch-ratio",el=>el.blur());
    await page.select("#pitch-ratio-unit","semitones");
    await page.$eval("#pitch-ratio",el=>{
      el.value="bad";el.dispatchEvent(new Event("change",{bubbles:true}));
    });
    await page.select("#pitch-ratio-unit","ratio");
    await page.focus("#pitch-ratio");
    assert.ok(Math.abs(Number(await page.$eval("#pitch-ratio",el=>el.value))-
      2**(1/12))<1e-12, "invalid typed ratio intervals must not overwrite r");
    await page.$eval("#pitch-ratio",el=>el.blur());
    await page.$eval("#pitch-ratio",el=>{
      el.value="1";el.dispatchEvent(new Event("change",{bubbles:true}));
    });
    assert.ok(Math.abs(Number(await page.$eval("#axis-pivot-value",el=>el.value))-110)<.005);

    // Linked P→F cannot lose fractional cents through historical round3().
    await page.select("#pivot-unit","note");
    await page.$eval("#axis-pivot-value",el=>{
      el.value="A3+25c";el.dispatchEvent(new Event("input",{bubbles:true}));
    });
    await page.focus("#fundamental");
    assert.ok(Math.abs(Number(await page.$eval("#fundamental",el=>el.value))-
      4*220*2**(25/1200))<1e-9, "linked P→F fractional cents must stay exact");
    await page.$eval("#fundamental",el=>el.blur());
    await page.select("#pivot-unit","hz");

    // Carrier c is independent of F/P, but its manual value is retained
    // while the pre-existing Fold-linked carrier mode disables manual edits.
    await page.$eval("#ring-enabled",el=>{
      el.checked=true;el.dispatchEvent(new Event("input",{bubbles:true}));
    });
    assert.equal(await page.$eval("#carrier-unit",el=>el.getBoundingClientRect().height>0),true);
    assert.equal(await page.$eval("#carrier-range",el=>el.dataset.fwSnap),"on");
    await page.select("#carrier-unit","note");
    await page.$eval("#carrier",el=>{
      el.value="A4+25c";el.dispatchEvent(new Event("input",{bubbles:true}));
    });
    await page.select("#carrier-unit","hz");
    await page.focus("#carrier");
    const carrierExact=Number(await page.$eval("#carrier",el=>el.value));
    assert.ok(Math.abs(carrierExact-440*2**(25/1200))<1e-9);
    await page.$eval("#carrier",el=>el.blur());
    await page.select("#carrier-unit","percent");
    assert.ok(Math.abs(Number(await page.$eval("#carrier",el=>el.value))-
      100*(1+999*Math.log(carrierExact)/Math.log(20000))/1000)<.01,
      "carrier percent must follow original zero+positive logarithmic rail");
    // Even below 1Hz, the view percentage must convert both directions.
    await page.$eval("#carrier",el=>{
      el.value="0.05";el.dispatchEvent(new Event("input",{bubbles:true}));
    });
    await page.select("#carrier-unit","hz");
    await page.focus("#carrier");
    assert.ok(Math.abs(Number(await page.$eval("#carrier",el=>el.value))-.5)<1e-8,
      "0.05% rail travel must roundtrip to 0.5Hz");
    await page.$eval("#carrier",el=>el.blur());
    await page.select("#carrier-unit","note");
    await page.$eval("#carrier-range",el=>{
      el.value="0";el.dispatchEvent(new Event("input",{bubbles:true}));
    });
    assert.equal(await page.$eval("#carrier-unit",el=>el.value),"hz");
    assert.equal(await page.$eval("#carrier",el=>Number(el.value)),0);
    await page.select("#carrier-unit","note");
    assert.equal(await page.$eval("#carrier-unit",el=>el.value),"hz");
    await page.$eval("#carrier",el=>{
      el.value="350";el.dispatchEvent(new Event("change",{bubbles:true}));
    });
    await page.select("#mode","fold-l");
    await page.$eval("#carrier-link",el=>{
      el.checked=true;el.dispatchEvent(new Event("change",{bubbles:true}));
    });
    assert.equal(await page.$eval("#carrier",el=>el.disabled),true);
    assert.equal(await page.$eval("#carrier-range",el=>el.disabled),true);
    assert.equal(await page.$eval("#carrier-unit",el=>el.disabled),true);
    await page.$eval("#carrier-link",el=>{
      el.checked=false;el.dispatchEvent(new Event("change",{bubbles:true}));
    });
    assert.equal(await page.$eval("#carrier",el=>el.disabled),false);
    await page.focus("#carrier");
    assert.equal(Number(await page.$eval("#carrier",el=>el.value)),350);
    await page.$eval("#carrier",el=>el.blur());
    await page.select("#mode","reciprocal");

    // Engine A floor reuses the frequency descriptor in its actual Settings UI.
    await page.click("#settings-open");
    await page.select("#engine","0");
    assert.equal(await page.$eval("#engine-a-settings",el=>el.hidden),false);
    assert.equal(await page.$eval("#a-min-unit",el=>el.getBoundingClientRect().height>0),true);
    assert.equal(await page.$eval("#a-min-unit",el=>el.value),"hz");
    assert.equal(await page.$eval("#a-min",el=>el.dataset.fwSnap),"on");
    await page.select("#a-min-unit","note");
    await page.$eval("#a-min-value",el=>{
      el.value="A4+25c";el.dispatchEvent(new Event("input",{bubbles:true}));
    });
    await page.select("#a-min-unit","hz");
    await page.focus("#a-min-value");
    const aMinExact=Number(await page.$eval("#a-min-value",el=>el.value));
    assert.ok(Math.abs(aMinExact-440*2**(25/1200))<1e-9);
    await page.$eval("#a-min-value",el=>el.blur());
    await page.select("#a-min-unit","percent");
    const aMinPct=Number(await page.$eval("#a-min-value",el=>el.value));
    const expectedAMinPct=100*(.2+.8*Math.log(aMinExact/20)/Math.log(1000));
    assert.ok(Math.abs(aMinPct-expectedAMinPct)<.01);
    await page.select("#a-min-unit","note");
    await page.$eval("#a-min-value",el=>{
      el.value="garbage";el.dispatchEvent(new Event("change",{bubbles:true}));
    });
    await page.select("#a-min-unit","hz");
    await page.focus("#a-min-value");
    assert.ok(Math.abs(Number(await page.$eval("#a-min-value",el=>el.value))-aMinExact)<1e-9);
    await page.$eval("#a-min-value",el=>el.blur());
    const aMinStep=Math.round(200+800*Math.log(440/20)/Math.log(1000));
    await page.$eval("#a-min",(el,step)=>{
      el.value=String(step);el.dispatchEvent(new Event("input",{bubbles:true}));
    },aMinStep);
    await page.focus("#a-min-value");
    assert.ok(Math.abs(Number(await page.$eval("#a-min-value",el=>el.value))-440)<1e-8);
    await page.$eval("#a-min-value",el=>el.blur());

    await page.click("#settings-reset");
    assert.equal(await page.$eval("#a-min-unit",el=>el.value),"hz");
    assert.equal(await page.$eval("#a-min",el=>el.dataset.fwSnap),"on");
    assert.equal(await page.$eval("#a-min-value",el=>Number(el.value)),20);
    assert.equal(await page.$eval("#pitch-ratio-unit",el=>el.value),"ratio");
    assert.equal(await page.$eval("#pitch-ratio-range",el=>el.dataset.fwSnap),"on");
    assert.equal(await page.$eval("#pitch-ratio",el=>Number(el.value)),1);
    assert.equal(await page.$eval("#axis-slope-unit",el=>el.value),"ratio");
    assert.equal(await page.$eval("#axis-slope",el=>el.dataset.fwSnap),"on");
    assert.equal(await page.$eval("#axis-slope-value",el=>Number(el.value)),1);
    await page.click("#settings-done");

    // Browser-only reference sine still has ONE physical Hz authority;
    // the MIDI36..96 source track must keep its .01 semitone granularity.
    assert.equal(await page.$eval("#sine-unit",el=>el.getBoundingClientRect().height>0),true);
    assert.equal(await page.$eval("#sine-unit",el=>el.value),"hz");
    assert.equal(await page.$eval("#sine-pitch",el=>el.dataset.fwSnap),"on");
    await page.select("#sine-unit","note");
    await page.$eval("#sine-hz",el=>{
      el.value="A4+25c";el.dispatchEvent(new Event("input",{bubbles:true}));
    });
    await page.select("#sine-unit","hz");
    await page.focus("#sine-hz");
    const sineExact=Number(await page.$eval("#sine-hz",el=>el.value));
    assert.ok(Math.abs(sineExact-440*2**(25/1200))<1e-9);
    assert.ok(Math.abs(Number(await page.$eval("#sine-cent",el=>el.value))-25)<.01);
    await page.select("#sine-unit","note");
    await page.$eval("#sine-hz",el=>{
      el.value="A4+25.375c";el.dispatchEvent(new Event("input",{bubbles:true}));
    });
    await page.$eval("#sine-hz",el=>el.blur());
    assert.equal(await page.$eval("#sine-hz",el=>el.value),"A4+25c");
    assert.equal(Number(await page.$eval("#sine-cent",el=>el.value)),25);
    await page.select("#sine-unit","hz");
    await page.focus("#sine-hz");
    assert.ok(Math.abs(Number(await page.$eval("#sine-hz",el=>el.value))-
      440*2**(25.375/1200))<1e-9);
    await page.$eval("#sine-hz",el=>el.blur());
    // Restore original +25c reference for the existing percent tests.
    await page.select("#sine-unit","note");
    await page.$eval("#sine-hz",el=>{
      el.value="A4+25c";el.dispatchEvent(new Event("input",{bubbles:true}));
    });
    await page.select("#sine-unit","hz");
    await page.$eval("#sine-hz",el=>el.blur());
    await page.select("#sine-unit","percent");
    assert.ok(Math.abs(Number(await page.$eval("#sine-hz",el=>el.value))-
      100*(69.25-36)/60)<.01);
    await page.select("#sine-unit","hz");
    await page.keyboard.down("Alt");
    await page.$eval("#sine-pitch",el=>{
      el.value="69.01";el.dispatchEvent(new Event("input",{bubbles:true}));
    });
    await page.keyboard.up("Alt");
    assert.equal(await page.$eval("#sine-pitch",el=>el.value),"69.01",
      "MIDI rail must not be rounded to integer semitones");
    await page.$eval("#sine-cent",el=>{
      el.value="20";el.dispatchEvent(new Event("input",{bubbles:true}));
    });
    assert.ok(Math.abs(Number(await page.$eval("#sine-pitch",el=>el.value))-69.2)<.0001);
    await page.select("#sine-unit","note");
    await page.$eval("#sine-hz",el=>{
      el.value="bad";el.dispatchEvent(new Event("change",{bubbles:true}));
    });
    await page.select("#sine-unit","hz");
    await page.focus("#sine-hz");
    assert.ok(Math.abs(Number(await page.$eval("#sine-hz",el=>el.value))-
      440*2**(.2/12))<1e-9);
    await page.$eval("#sine-hz",el=>el.blur());
    await page.$eval("#sine-pitch",el=>{
      el.value="69.05";el.dispatchEvent(new Event("input",{bubbles:true}));
    });
    await page.focus("#sine-hz");
    assert.ok(Math.abs(Number(await page.$eval("#sine-hz",el=>el.value))-440)<1e-8);
    await page.$eval("#sine-hz",el=>el.blur());

    assert.equal(await page.$eval("#pivot-unit",el=>el.value),"hz");
    assert.equal(await page.$eval("#axis-pivot",el=>el.dataset.fwSnap),"on");
    assert.equal(await page.$eval("#axis-pivot-value",el=>Number(el.value)),350);
    assert.equal(await page.$eval("#harmonic-pivot-link",el=>el.checked),false);
    assert.equal(await page.$eval("#high-unit",el=>el.value),"hz");
    assert.equal(await page.$eval("#high",el=>el.dataset.fwSnap),"on");
    assert.equal(await page.$eval("#high-value",el=>Number(el.value)),16000);
    assert.equal(await page.$eval("#low-unit",el=>el.value),"hz");
    assert.equal(await page.$eval("#low",el=>el.dataset.fwSnap),"on");
    assert.equal(await page.$eval("#low-value",el=>Number(el.value)),20);
    assert.equal(await page.$eval("#low",el=>el.value),"200");
    // Opt-in layout editor coexists: it must NOT hijack snap menus on
    // a recognized parameter, but retains its context menu elsewhere.
    await page.goto("http://127.0.0.1:8774/index.html?layout_editor=1",{
      waitUntil:"domcontentloaded"
    });
    await page.waitForFunction(()=>document.documentElement.dataset.fwBoot==="ready",{
      timeout:18000
    });
    await page.waitForSelector("#fw-layout-inspector");
    await page.$eval("#low-thumb",el=>el.dispatchEvent(new MouseEvent("contextmenu",{
      bubbles:true,cancelable:true,clientX:80,clientY:135
    })));
    assert.equal(await page.$eval("#fw-unit-snap-menu",el=>el.hidden),false);
    assert.equal(await page.$eval("#fw-layout-inspector",el=>
      el.shadowRoot.querySelector("#fw-context-menu").hidden),true);
    assert.deepEqual(errors,[],"browser JS errors: "+errors.join("; "));
  }finally {
    await browser?.close();
    server.kill();
  }
});
