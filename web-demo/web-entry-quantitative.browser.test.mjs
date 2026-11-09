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
  {name:"legacy",suffix:"&layout_editor=1",host:"#fw-layout-inspector"},
  {name:"v2",suffix:"&visual_editor_v2=1",host:"#visual-editor-v2"}
];
const viewports=[
  {width:320,height:844},{width:390,height:844},{width:768,height:844},{width:1280,height:844},
  {width:390,height:320},{width:390,height:560},{width:390,height:561}
];
const base="http://127.0.0.1:8799/index.html?legacy_lab=1";
function assertRecord(record){
  const who=record.mode+"/"+record.width+"×"+record.height;
  assert.ok(record.bootMs>=0&&record.bootMs<20000,who+" bootstrap timing "+JSON.stringify(record));
  assert.equal(record.extraIds,0,who+" duplicated IDs");
  assert.equal(record.pageOverflowPx<=1,true,who+" horizontal overflow "+JSON.stringify(record));
  if(record.width<=390){
    const live=record.mobileControlGraph;
    assert.ok(live?.graphVisible&&live?.railVisible,
      who+" graph and operated rail must stay visible together "+JSON.stringify(live));
    assert.equal(live?.overlap,false,
      who+" graph must not cover the operated rail "+JSON.stringify(live));
    assert.ok(live?.graphHit&&live?.railHit,
      who+" graph and rail must both receive touch "+JSON.stringify(live));
    assert.ok(live?.valueChanged&&live?.graphChanged,
      who+" touching the rail must update its value and visible graph "+JSON.stringify(live));
    assert.ok(record.curveLeft>=0&&record.curveRight<=record.width+1,
      who+" graph escapes the viewport "+JSON.stringify(record));
    const minimumGraphWidth=Math.min(record.width*.5,
      record.height<=400?record.height*.44:record.height*.24);
    assert.ok(record.curveWidth+1>=minimumGraphWidth,
      who+" graph is too narrow to use "+JSON.stringify(record));
    assert.ok(record.squareErrorPx<=2,who+" right graph not square");
  }
  for(const [id,hit] of Object.entries(record.hits)){
    assert.ok(hit.reachable,who+" cannot physically hit "+id+": "+JSON.stringify(hit));
    assert.ok(hit.height>=36,who+" "+id+" real hitbox too short "+JSON.stringify(hit));
  }
  assert.equal(record.restoredFocus,"settings-open",who+" Settings return focus");
  assert.equal(record.editorVisible,record.mode!=="ordinary",who+" incorrect editor opt-in state");
}
test("W1: three entry modes × seven viewport sizes, quantified reachability and state isolation",{
  timeout:180000
},async()=>{
  const server=spawn(process.env.PYTHON_BIN||(process.platform==="win32"?"python":"python3"),
    ["-m","http.server","8799","--bind","127.0.0.1"],{
    cwd:resolve(process.env.WARP_WEB_ROOT||"_site"),stdio:"ignore"
  });
  let browser;
  try{
    browser=await puppeteer.launch({executablePath:process.env.CHROME_BIN||"/usr/bin/google-chrome",headless:true,
      args:["--no-sandbox","--disable-dev-shm-usage"]});
    const rows=[];
    // The published default entry is a separate UX contract from the legacy
    // harmonic lab below. Test the real source -> F/H -> controls -> graph
    // reading order and the auxiliary panel's relationship to that graph.
    for(const {width,height} of viewports){
      const page=await browser.newPage(),errors=[];
      page.on("pageerror",e=>errors.push(e.message));
      await page.setViewport({width,height,deviceScaleFactor:1,
        isMobile:width<=390,hasTouch:width<=390});
      await page.goto("http://127.0.0.1:8799/index.html",{waitUntil:"domcontentloaded"});
      await page.waitForFunction(()=>
        document.documentElement.dataset.fwBoot==="ready",{timeout:20000});
      const layout=await page.evaluate(()=>{
        const box=selector=>{
          const {x,y,left,top,right,bottom,width,height}=document.querySelector(selector).getBoundingClientRect();
          return {x,y,left,top,right,bottom,width,height};
        };
        const measure=rect=>({x:rect.x,y:rect.y,left:rect.left,top:rect.top,
          right:rect.right,bottom:rect.bottom,width:rect.width,height:rect.height});
        const source=box(".player"),harmonics=box("#virtual-root-workbench");
        const controls=box(".quick-panel"),graph=box(".workspace-right");
        const curve=box(".curve-panel"),sine=box(".sine-monitor");
        const shape=measure(document.querySelector("#axis-shift").closest(".control").getBoundingClientRect());
        const wet=measure(document.querySelector("#wet").closest(".control").getBoundingClientRect());
        const value=box("#wet-value"),label=box('label[for="wet"]');
        const harmonicFields=["source-f","target-h","step-m","first-index"].map(key=>{
          const field=document.querySelector(`[data-vr-control="${key}"]`);
          const number=field.querySelector(".vr-number-row").getBoundingClientRect();
          const rail=(field.querySelector(".vr-linear-rail")||
            field.querySelector(':scope > input[type="range"]')).getBoundingClientRect();
          return {key,height:field.getBoundingClientRect().height,
            number:{left:number.left,right:number.right,top:number.top,bottom:number.bottom},
            rail:{left:rail.left,right:rail.right,top:rail.top,bottom:rail.bottom}};
        });
        return {width:innerWidth,pageOverflowPx:Math.max(0,document.documentElement.scrollWidth-innerWidth),
          source,harmonics,controls,graph,curve,sine,shape,wet,value,label,harmonicFields};
      });
      const context=`default/${width}`;
      assert.equal(layout.pageOverflowPx<=1,true,context+" horizontal overflow "+JSON.stringify(layout));
      assert.ok(layout.harmonics.bottom<=layout.graph.top+1,
        context+" harmonic setup must precede the graph "+JSON.stringify(layout));
      assert.ok(layout.sine.top>=layout.graph.bottom-1,
        context+" auxiliary tone must sit below the graph "+JSON.stringify(layout));
      assert.ok(Math.abs(layout.sine.right-layout.graph.right)<=2,
        context+" auxiliary tone must align to the graph's right edge "+JSON.stringify(layout));
      assert.ok(Math.abs((layout.value.top+layout.value.bottom)/2-
        (layout.label.top+layout.label.bottom)/2)<=8,
        context+" numeric value must remain inline with its label "+JSON.stringify(layout));
      if(width<=800){
        const minimumCurveWidth=width>680?width*.35:width-100;
        assert.ok(layout.curve.width>=minimumCurveWidth,
          context+" graph is too narrow to use "+JSON.stringify(layout));
        assert.ok(layout.curve.left>=0&&layout.curve.right<=width+1,
          context+" graph must be fully visible "+JSON.stringify(layout));
        assert.ok(layout.sine.width<width-100,
          context+" auxiliary tone must not stretch across the full mobile row "+JSON.stringify(layout));
        if(width<=390){
          for(const field of layout.harmonicFields){
            assert.ok(Math.abs(field.number.top-field.rail.top)<=4,
              context+" "+field.key+" value and slider should share one row "+JSON.stringify(field));
            assert.ok(field.rail.left>=field.number.right-1,
              context+" "+field.key+" slider should sit beside its value "+JSON.stringify(field));
          }
        }
        assert.ok(Math.abs(layout.shape.top-layout.wet.top)<=2,
          context+" main controls should use two compact columns "+JSON.stringify(layout));
      }else{
        assert.ok(layout.source.left<layout.harmonics.left,
          context+" source and harmonic setup should share the first row "+JSON.stringify(layout));
      }
      assert.deepEqual(errors,[],context+" runtime failures");
      await page.close();
    }
    for(const mode of modes){
      for(const {width,height} of viewports){
        const page=await browser.newPage(),errors=[];
        page.on("pageerror",e=>errors.push(e.message));
        await page.setViewport({width,height,deviceScaleFactor:1,
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
        const metrics=await page.evaluate(async({width,height,name,host})=>{
          const box=selector=>document.querySelector(selector).getBoundingClientRect();
          const curve=box("#curve"),graphPanel=box(".workspace-right");
          const candidates=["#settings-open","#export-jump","#pivot-link-target"];
          const hits={};
          for(const selector of candidates){
            const el=document.querySelector(selector);
            el.scrollIntoView({block:"center"});
            const b=el.getBoundingClientRect(),x=b.left+b.width/2,y=b.top+b.height/2;
            const receiver=document.elementFromPoint(x,y);
            const r=receiver?.getBoundingClientRect();
            hits[selector]={reachable:receiver===el||el.contains(receiver),height:b.height,
              width:b.width,centerX:x,centerY:y,rect:{top:b.top,bottom:b.bottom,left:b.left,right:b.right},
              receiver:receiver?.id||receiver?.className||receiver?.tagName||null,
              receiverRect:r?{top:r.top,bottom:r.bottom,left:r.left,right:r.right}:null};
          }
          const ids=[...document.querySelectorAll("[id]")].map(x=>x.id);
          const extraIds=ids.length-new Set(ids).size;
          const pageOverflowPx=Math.max(0,document.documentElement.scrollWidth-innerWidth);
          const editorVisible=Boolean(host&&document.querySelector(host)?.shadowRoot);
        return {mode:name,width,height,pageOverflowPx,graphPanelHeight:graphPanel.height,
          curveLeft:curve.left,curveRight:curve.right,
            curveWidth:curve.width,squareErrorPx:Math.abs(curve.width-curve.height),extraIds,hits,editorVisible};
        },{name:mode.name,width,height,host:mode.host});
        metrics.bootMs=Date.now()-start;
        if(mode.name==="legacy"){
          const state=await page.evaluate(()=>{
            const host=document.querySelector("#fw-layout-inspector");
            const pick=host.shadowRoot.querySelector("[data-action=pick]");
            const b=pick.getBoundingClientRect();
            return {preview:host.classList.contains("previewing"),height:b.height,
              visible:getComputedStyle(pick).display!=="none",x:b.x+b.width/2,y:b.y+b.height/2};
          });
          assert.ok(state.preview&&state.visible&&state.height>20,
            "Legacy preview must retain an edit re-entry affordance: "+JSON.stringify(state));
          await page.mouse.click(state.x,state.y);
          assert.equal(await page.$eval("#fw-layout-inspector",el=>el.classList.contains("previewing")),false,
            "User can leave preview via real mouse/touch hit on the return control");
          await page.evaluate(()=>document.querySelector("#fw-layout-inspector").shadowRoot
            .querySelector("[data-action=preview]").click());
        }
        await page.click("#settings-open");
        assert.equal(await page.$eval("#settings-dialog",el=>el.open),true,
          mode.name+"/"+width+" settings unavailable");
        if(mode.name==="ordinary"&&width===390){
          assert.equal(await page.$eval("#low-value",el=>Number(el.dataset.fwCanonical)),0.001,
            "initial canonical L is 0.001Hz");
          assert.equal(await page.$$eval("#a-min, #a-min-value, #a-min-unit",els=>els.length),0,
            "Engine A has no duplicate minimum-frequency control");
          await page.click("#settings-reset");
          assert.equal(await page.$eval("#low-value",el=>Number(el.dataset.fwCanonical)),0.001,
            "reset canonical L is 0.001Hz");
        }
        await page.click("#settings-done");
        metrics.restoredFocus=await page.evaluate(()=>document.activeElement?.id);
        if(width<=390){
          const before=await page.evaluate(async(shortViewport)=>{
            const rail=document.querySelector("#axis-shift");
            rail.scrollIntoView({block:shortViewport?"end":"center",inline:"nearest"});
            await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
            const railBox=rail.getBoundingClientRect();
            const graph=document.querySelector("#curve"),graphBox=graph.getBoundingClientRect();
            const railX=railBox.left+railBox.width*.75,railY=(railBox.top+railBox.bottom)/2;
            const graphX=(graphBox.left+graphBox.right)/2,graphY=(graphBox.top+graphBox.bottom)/2;
            const railReceiver=document.elementFromPoint(railX,railY);
            const graphReceiver=document.elementFromPoint(graphX,graphY);
            const graphVisible=graphBox.left>=0&&graphBox.top>=0&&
              graphBox.right<=innerWidth&&graphBox.bottom<=innerHeight;
            const railVisible=railBox.left>=0&&railBox.top>=0&&
              railBox.right<=innerWidth&&railBox.bottom<=innerHeight+1;
            const overlap=graphBox.left<railBox.right&&graphBox.right>railBox.left&&
              graphBox.top<railBox.bottom&&graphBox.bottom>railBox.top;
            return {railX,railY,initialValue:Number(rail.value),graphImage:graph.toDataURL(),
              graphVisible,railVisible,overlap,
              graphHit:graphReceiver===graph,
              railHit:railReceiver===rail};
          },height<=560);
          await page.touchscreen.tap(before.railX,before.railY);
          await page.waitForFunction(initialValue=>
            Number(document.querySelector("#axis-shift").value)!==initialValue,
          {timeout:2500},before.initialValue);
          const after=await page.evaluate(()=>({
            value:Number(document.querySelector("#axis-shift").value),
            graphImage:document.querySelector("#curve").toDataURL()
          }));
          metrics.mobileControlGraph={graphVisible:before.graphVisible,
            railVisible:before.railVisible,overlap:before.overlap,
            graphHit:before.graphHit,railHit:before.railHit,
            valueChanged:after.value!==before.initialValue,
            graphChanged:after.graphImage!==before.graphImage};
        }
        metrics.errors=errors;
        rows.push(metrics);
        assertRecord(metrics);
        assert.deepEqual(errors,[],mode.name+"/"+width+" runtime failures");
        await page.close();
      }
    }
    const at560=rows.find(x=>x.mode==="ordinary"&&x.width===390&&x.height===560);
    const at561=rows.find(x=>x.mode==="ordinary"&&x.width===390&&x.height===561);
    assert.ok(Math.abs(at560.curveWidth-at561.curveWidth)<=2,
      "Graph width should not jump at 560/561px viewport height: "+JSON.stringify({at560,at561}));
    assert.ok(Math.abs(at560.graphPanelHeight-at561.graphPanelHeight)<=2,
      "Graph panel height should not jump at 560/561px viewport height: "+JSON.stringify({at560,at561}));
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
      matrixCount:rows.length,modes:modes.map(m=>m.name),viewports,
      maxOverflowPx:Math.max(...rows.map(x=>x.pageOverflowPx)),
      maxGraphSquareErrorPx:Math.max(...rows.map(x=>x.squareErrorPx)),
      maxBootMs:Math.max(...rows.map(x=>x.bootMs)),
      minTargetHeightPx:Math.min(...rows.flatMap(x=>Object.values(x.hits).map(y=>y.height))),
      measurements:rows.map(({mode,width,height,graphPanelHeight,curveWidth,bootMs,pageOverflowPx,squareErrorPx})=>
        ({mode,width,height,graphPanelHeight,curveWidth,bootMs,pageOverflowPx,squareErrorPx})),
      zoomDiagnostic:zoomMetrics
    }));
  }finally{
    await browser?.close();
    server.kill("SIGTERM");
  }
});
