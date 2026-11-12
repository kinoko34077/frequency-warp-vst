/** #355 G1: shared field and range tokens with purpose-specific geometry preserved. */
import {test} from "node:test";
import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {resolve} from "node:path";
import puppeteer from "puppeteer-core";

const port=8855,site="http://127.0.0.1:"+port+"/index.html";
async function waitForServer(){
  for(let n=0;n<55;n++){
    try{const r=await fetch(site);await r.arrayBuffer();if(r.ok)return;}
    catch{}
    await new Promise(ok=>setTimeout(ok,100));
  }
  throw Error("G1 staged Pages server unavailable");
}
const railIds=[
  "wet","axis-shift","graph-log","a-reverb","carrier-range",
  "crusher-bits","sine-pitch","sine-volume","vr-source-f-rail"
];
test("#355 G1 field/rail styles have one token owner while distinct UI geometry remains",{
  timeout:60000
},async()=>{
  const server=spawn(process.env.PYTHON_BIN||"python3",
    ["-m","http.server",String(port),"--bind","127.0.0.1"],{
      cwd:resolve(process.env.WARP_WEB_ROOT||"_site"),stdio:"ignore"
    });
  let browser;
  try{
    await waitForServer();
    browser=await puppeteer.launch({
      executablePath:process.env.CHROME_BIN||"/usr/bin/google-chrome",
      headless:true,args:["--no-sandbox","--disable-dev-shm-usage"]
    });
    for(const width of [390,1365]){
      const page=await browser.newPage(),errors=[];
      page.on("pageerror",e=>errors.push(e.message));
      await page.setViewport({width,height:844,isMobile:width<=390,hasTouch:width<=390,deviceScaleFactor:1});
      await page.goto(site,{waitUntil:"domcontentloaded"});
      await page.waitForFunction(()=>document.documentElement.dataset.fwBoot==="ready",{timeout:20000});
      const baseline=await page.evaluate(ids=>{
        const css=el=>{const x=getComputedStyle(el),r=el.getBoundingClientRect();
          return {accent:x.accentColor,background:x.backgroundColor,color:x.color,
            border:x.borderTopColor,borderWidth:x.borderTopWidth,
            padding:x.padding,width:r.width,height:r.height};};
        const rails=ids.map(id=>({id,style:css(document.getElementById(id))}));
        const fields=["invert-value","zero-decay-value","axis-shift-value","wet-value",
          "low-value","fundamental","sine-hz","a-quality-value","vr-source-f"];
        const values=fields.map(id=>({id,style:css(document.getElementById(id))}));
        return {rails,values,fieldCount:document.querySelectorAll("input.inline-value").length};
      },railIds);
      assert.equal(baseline.fieldCount,20,"the measured G0b inline-field inventory must be preserved");
      const accents=new Set(baseline.rails.map(x=>x.style.accent));
      assert.deepEqual([...accents],["rgb(85, 215, 182)"],
        "all ordinary physical range skins must share the same semantic accent: "+
        JSON.stringify(baseline.rails));
      const byId=Object.fromEntries(baseline.values.map(x=>[x.id,x.style]));
      assert.equal(byId["fundamental"].background,byId["sine-hz"].background);
      assert.equal(byId["sine-hz"].background,byId["a-quality-value"].background,
        "standard typed fields retain one shared surface");
      assert.equal(byId["axis-shift-value"].background,byId["wet-value"].background,
        "compact quick controls retain the same transparent presentation");
      assert.equal(byId["invert-value"].padding,byId["zero-decay-value"].padding,
        "dual-head labels retain consistent padding, independent of standard fields");
      assert.ok(byId["vr-source-f"].height>byId["wet-value"].height,
        "virtual-root larger direct input is a justified variant, not flattened");
      const changed=await page.evaluate(ids=>{
        document.documentElement.style.setProperty("--fw-ui-range-accent","#ff00aa");
        document.documentElement.style.setProperty("--fw-ui-field-bg","#123456");
        const rect=el=>{const r=el.getBoundingClientRect();return {width:r.width,height:r.height};};
        return {rails:ids.map(id=>({id,color:getComputedStyle(document.getElementById(id)).accentColor,
          ...rect(document.getElementById(id))})),
          standard:["fundamental","sine-hz","a-quality-value"].map(id=>getComputedStyle(document.getElementById(id)).backgroundColor),
          compact:getComputedStyle(document.getElementById("wet-value")).backgroundColor};
      },railIds);
      assert.ok(changed.rails.every(x=>x.color==="rgb(255, 0, 170)"),
        "changing the single rail token must update every existing consumer");
      assert.deepEqual(changed.standard,Array(3).fill("rgb(18, 52, 86)"),
        "changing the standard-field token must propagate to every standard consumer");
      assert.equal(changed.compact,"rgba(0, 0, 0, 0)",
        "compact inline view is a deliberate semantic variant");
      for(const item of changed.rails){
        const b=baseline.rails.find(x=>x.id===item.id).style;
        assert.ok(Math.abs(item.width-b.width)<.1&&Math.abs(item.height-b.height)<.1,
          "palette updates must not change gesture hit geometry: "+item.id);
      }
      console.log("G1_TOKENS "+JSON.stringify({width,fields:baseline.fieldCount,
        rails:changed.rails.map(x=>x.id),roleGroups:["standard","compact","dual","virtual"],
        before:baseline.rails.map(x=>x.style.accent),after:changed.rails.map(x=>x.color)}));
      assert.deepEqual(errors,[],"token adjustments must not throw UI errors");
      await page.close();
    }
  }finally{await browser?.close();server.kill();}
});
