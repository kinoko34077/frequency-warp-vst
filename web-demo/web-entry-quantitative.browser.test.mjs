/** W1 quantitative user-entry audit; device emulation != physical iOS evidence.
 * Measure the user task rather than simply checking for component presence.
 */
import {test} from "node:test";
import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {resolve} from "node:path";
import puppeteer from "puppeteer-core";

const modes=[
  {name:"ordinary",suffix:"",host:null},
  {name:"legacy",suffix:"?layout_editor=1",host:"#fw-layout-inspector"},
  {name:"v2",suffix:"?visual_editor_v2=1",host:"#visual-editor-v2"}
];
const widths=[320,390,768,1280];
const base="http://127.0.0.1:8799/index.html";
function assertRecord(record){
  const who=record.mode+"/"+record.width;
  assert.ok(record.bootMs>=0&&record.bootMs<20000,who+" bootstrap timing "+JSON.stringify(record));
  assert.equal(record.extraIds,0,who+" duplicated IDs");
  assert.equal(record.pageOverflowPx<=1,true,who+" horizontal overflow "+JSON.stringify(record));
  if(record.width<=390){
    assert.ok(record.leftRight<=record.rightLeft+1,who+" left controls/right graph reversed");
    assert.ok(record.squareErrorPx<=2,who+" right graph not square");
  }
  for(const [id,hit] of Object.entries(record.hits)){
    assert.ok(hit.reachable,who+" cannot physically hit "+id+": "+JSON.stringify(hit));
    assert.ok(hit.height>=36,who+" "+id+" real hitbox too short "+JSON.stringify(hit));
  }
  assert.equal(record.restoredFocus,"settings-open",who+" Settings return focus");
  assert.equal(record.editorVisible,record.mode!=="ordinary",who+" incorrect editor opt-in state");
}
test("W1: three independent entry modes × four widths, quantified reachability and state isolation",{
  timeout:180000
},async()=>{
  const server=spawn("python3",["-m","http.server","8799","--bind","127.0.0.1"],{
    cwd:resolve(process.env.WARP_WEB_ROOT||"_site"),stdio:"ignore"
  });
  let browser;
  try{
    browser=await puppeteer.launch({executablePath:process.env.CHROME_BIN||"/usr/bin/google-chrome",headless:true,
      args:["--no-sandbox","--disable-dev-shm-usage"]});
    const rows=[];
    for(const mode of modes){
      for(const width of widths){
        const page=await browser.newPage(),errors=[];
        page.on("pageerror",e=>errors.push(e.message));
        await page.setViewport({width,height:844,deviceScaleFactor:1,
          isMobile:width<=390,hasTouch:width<=390});
        const start=Date.now();
        await page.goto(base+mode.suffix,{waitUntil:"domcontentloaded"});
        await page.waitForFunction(()=>
          document.documentElement.dataset.fwBoot==="ready",{timeout:20000});
        if(mode.host){
          await page.waitForFunction(selector=>
            Boolean(document.querySelector(selector)?.shadowRoot),{},mode.host);
          await page.evaluate(name=>{
            const host=document.querySelector(name==="legacy"?"#fw-layout-inspector":"#visual-editor-v2");
            const selector=name==="legacy"?"[data-action=preview]":"#preview";
            host.shadowRoot.querySelector(selector).click();
          },mode.name);
        }
        const metrics=await page.evaluate(async({width,name,host})=>{
          const box=selector=>document.querySelector(selector).getBoundingClientRect();
          const left=box(".workspace-left"),right=box(".workspace-right"),curve=box("#curve");
          const candidates=["#settings-open","#export-jump","#pivot-link-target"];
          const hits={};
          for(const selector of candidates){
            const el=document.querySelector(selector);
            el.scrollIntoView({block:"center"});
            const b=el.getBoundingClientRect(),x=b.left+b.width/2,y=b.top+b.height/2;
            const receiver=document.elementFromPoint(x,y);
            hits[selector]={reachable:receiver===el||el.contains(receiver),height:b.height,
              width:b.width,centerX:x,centerY:y};
          }
          const ids=[...document.querySelectorAll("[id]")].map(x=>x.id);
          const extraIds=ids.length-new Set(ids).size;
          const pageOverflowPx=Math.max(0,document.documentElement.scrollWidth-innerWidth);
          const editorVisible=Boolean(host&&document.querySelector(host)?.shadowRoot);
          return {mode:name,width,pageOverflowPx,leftRight:left.right,rightLeft:right.left,
            squareErrorPx:Math.abs(curve.width-curve.height),extraIds,hits,editorVisible};
        },{name:mode.name,width,host:mode.host});
        metrics.bootMs=Date.now()-start;
        await page.click("#settings-open");
        assert.equal(await page.$eval("#settings-dialog",el=>el.open),true,
          mode.name+"/"+width+" settings unavailable");
        await page.click("#settings-done");
        metrics.restoredFocus=await page.evaluate(()=>document.activeElement?.id);
        metrics.errors=errors;
        rows.push(metrics);
        assertRecord(metrics);
        assert.deepEqual(errors,[],mode.name+"/"+width+" runtime failures");
        await page.close();
      }
    }
    // This is a browser approximation, not an OS/browser 200% zoom or
    // physical soft-keyboard check. Print diagnostic measurements separately.
    const zoom=await browser.newPage();
    await zoom.setViewport({width:768,height:844});
    await zoom.goto(base,{waitUntil:"domcontentloaded"});
    await zoom.waitForFunction(()=>document.documentElement.dataset.fwBoot==="ready");
    const zoomMetrics=await zoom.evaluate(()=>{
      document.body.style.zoom="2";
      const graph=document.querySelector("#curve").getBoundingClientRect();
      return {simulation:"CSS zoom 200%, not physical browser zoom",
        overflowPx:Math.max(0,document.documentElement.scrollWidth-innerWidth),
        graphAspectErrorPx:Math.abs(graph.width-graph.height),
        pageWidth:innerWidth};
    });
    await zoom.close();
    console.log("W1_MACHINE_AUDIT "+JSON.stringify({
      matrixCount:rows.length,modes:modes.map(m=>m.name),widths,
      maxOverflowPx:Math.max(...rows.map(x=>x.pageOverflowPx)),
      maxGraphSquareErrorPx:Math.max(...rows.map(x=>x.squareErrorPx)),
      maxBootMs:Math.max(...rows.map(x=>x.bootMs)),
      minTargetHeightPx:Math.min(...rows.flatMap(x=>Object.values(x.hits).map(y=>y.height))),
      measurements:rows.map(({mode,width,bootMs,pageOverflowPx,squareErrorPx})=>
        ({mode,width,bootMs,pageOverflowPx,squareErrorPx})),
      zoomDiagnostic:zoomMetrics
    }));
  }finally{
    await browser?.close();
    server.kill("SIGTERM");
  }
});
