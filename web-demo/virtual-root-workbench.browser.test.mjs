import {test} from "node:test";
import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {resolve} from "node:path";
import puppeteer from "puppeteer-core";
test("virtual root H/m/h1 workbench: real Chrome target, sub-millihertz, fold q and DSP preflight",{
  timeout:100000
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
      await page.setViewport({width,height:844,deviceScaleFactor:1,
        isMobile:width<=390,hasTouch:width<=390});
      const errors=[];page.on("pageerror",e=>errors.push(e.message));
      await page.goto("http://127.0.0.1:8798/index.html",{waitUntil:"domcontentloaded"});
      await page.waitForFunction(()=>document.documentElement.dataset.fwBoot==="ready",
        {timeout:20000});
      assert.equal(await page.$eval("#vr-target-h",el=>el.value),"87.5");
      assert.match(await page.$eval("#vr-summary",el=>el.textContent),/87.5 Hz/);
      assert.equal(await page.$eval("#vr-mode",el=>el.value),"series");
      assert.equal(await page.$eval("#vr-fold-field",el=>el.hidden),true);
      assert.equal(await page.$eval("#vr-formula [role=math]",el=>el.getAttribute("aria-label")),"-3 / 4");
      const bars=await page.$$eval("#vr-preview [role=listitem]",els=>els.length);
      assert.equal(bars,8);
      assert.equal(await page.$eval("#vr-preview .vr-original-bar",xs=>xs.length),8,
        "Source frequencies must be visually comparable with 8 transformed bars");
      // A theoretical target smaller than a physical P tick remains positive,
      // present in the editor, and never detaches/mutates the old audio binding.
      await page.$eval("#harmonic-pivot-link",el=>{el.checked=true;});
      await page.$eval("#vr-target-h",el=>{
        el.value="0.0009";el.dispatchEvent(new Event("input",{bubbles:true}));
      });
      assert.equal(await page.$eval("#vr-target-h",el=>el.value),"0.0009");
      assert.ok(await page.$eval("#vr-h-rail",el=>Number(el.value))>0,
        "Positive sub-.001 H must not snap onto the physical P=0 slider point");
      await page.$eval("#vr-h-rail",el=>{
        el.value="0";el.dispatchEvent(new Event("input",{bubbles:true}));
      });
      assert.ok(await page.$eval("#vr-target-h",el=>Number(el.value))>0,
        "Gesture minimum must be strictly positive, never 0Hz");
      await page.$eval("#vr-target-h",el=>{
        el.value="0.0009";el.dispatchEvent(new Event("input",{bubbles:true}));
      });
      assert.equal(await page.$eval("#vr-apply",el=>el.disabled),true);
      assert.match(await page.$eval("#vr-summary",el=>el.textContent),/0.0009/);
      assert.equal(await page.$eval("#harmonic-pivot-link",el=>el.checked),true);
      await page.$eval("#vr-target-h",el=>{
        el.value="87.5";el.dispatchEvent(new Event("input",{bubbles:true}));
      });
      // q must only be offered where it moves a real *reflected* partial.
      await page.select("#vr-mode","fold-to-root");
      assert.equal(await page.$eval("#vr-fold-field",el=>el.hidden),false);
      assert.equal(await page.$eval("#vr-first-field",el=>el.hidden),true);
      await page.$eval("#vr-fold-q",el=>{
        el.value="2";el.dispatchEvent(new Event("input",{bubbles:true}));
      });
      assert.equal(await page.$eval("#vr-formula [role=math]",el=>el.getAttribute("aria-label")),"-9 / 4");
      assert.match(await page.$eval("#vr-preview",el=>el.textContent),/第2倍音.*仮想基音へ到達/);
      assert.equal(await page.$eval("#vr-apply",el=>el.disabled),false);
      const before=await page.$eval("#axis-pivot-value",el=>el.dataset.fwCanonical);
      await page.click("#vr-apply");
      assert.equal(await page.$eval("#numerator",el=>Number(el.value)),-9);
      assert.equal(await page.$eval("#harmonic-index",el=>Number(el.value)),2);
      assert.equal(await page.$eval("#rational-enabled",el=>el.checked),true);
      assert.equal(await page.$eval("#harmonic-pivot-link",el=>el.checked),false,
        "Old physical P linkage is intentionally separate when new DSP configuration is applied");
      assert.equal(await page.$eval("#axis-pivot-value",el=>el.dataset.fwCanonical),before,
        "Virtual root H must not rewrite unrelated physical Warp P");
      await page.select("#vr-mode","series");
      await page.click("[data-vr-preset='4:3']");
      assert.equal(await page.$eval("#vr-formula [role=math]",el=>el.getAttribute("aria-label")),"-1 / 4");
      assert.match(await page.$eval("#vr-summary",el=>el.textContent),/未出現/);
      await page.select("#vr-placement","keep-spacing");
      assert.equal(await page.$eval("#vr-target-h",el=>el.readOnly),true);
      assert.deepEqual(errors,[],width+" runtime errors");
      const spill=await page.evaluate(()=>Math.max(0,document.documentElement.scrollWidth-innerWidth));
      assert.ok(spill<=1,"Workbench must not cause horizontal overflow at "+width+"px: "+spill);
      await page.close();
    }
  }finally{await browser?.close();server.kill("SIGTERM");}
});
