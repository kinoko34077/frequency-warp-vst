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
    await page.$eval("#low-value",el=>el.blur());

    // Existing keyboard accessible thumb path must continue to emit native input.
    await page.focus("#low-thumb");
    await page.keyboard.press("ArrowRight");
    assert.ok(Number(await page.$eval("#low",el=>el.value))>=railStep);

    await page.click("#settings-open");
    await page.click("#settings-reset");
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
