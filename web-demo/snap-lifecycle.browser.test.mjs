/** #355 G4: attach/dispose/remount must not retain snap gesture listeners. */
import {test} from "node:test";
import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {resolve} from "node:path";
import puppeteer from "puppeteer-core";

const port=8860,site="http://127.0.0.1:"+port+"/index.html";
test("#355 G4 snap target lifecycle removes doc handlers, context toggles and pending long holds",{
  timeout:60000
},async()=>{
  const server=spawn(process.env.PYTHON_BIN||"python3",
    ["-m","http.server",String(port),"--bind","127.0.0.1"],{
      cwd:resolve(process.env.WARP_WEB_ROOT||"_site"),stdio:"ignore"
    });
  let browser;
  try{
    for(let n=0;n<50;n++){
      try{const r=await fetch(site);await r.arrayBuffer();if(r.ok)break;}
      catch{}
      if(n===49)throw Error("G4 Pages server not ready");
      await new Promise(done=>setTimeout(done,100));
    }
    browser=await puppeteer.launch({executablePath:process.env.CHROME_BIN||"/usr/bin/google-chrome",
      headless:true,args:["--no-sandbox","--disable-dev-shm-usage"]});
    const page=await browser.newPage(),errors=[];
    page.on("pageerror",e=>errors.push(e.message));
    await page.setViewport({width:390,height:844,isMobile:true,hasTouch:true});
    await page.goto(site,{waitUntil:"domcontentloaded"});
    await page.waitForFunction(()=>document.documentElement.dataset.fwBoot==="ready",{timeout:20000});
    const result=await page.evaluate(async()=>{
      const {attachParameterSnapControls}=await import("./frequency-unit-field.mjs");
      const targets=Array.from({length:4},(_,i)=>{
        const node=document.createElement("input");
        node.type="text";node.value=String(i);node.title="original "+i;
        node.setAttribute("aria-description","previous "+i);
        document.body.append(node);return node;
      });
      const beforeAdd=document.addEventListener.bind(document);
      const beforeRemove=document.removeEventListener.bind(document);
      const types=new Set(["pointermove","pointerup","pointercancel","scroll"]);
      const added={},removed={};
      document.addEventListener=(name,listener,options)=>{
        if(types.has(name))added[name]=(added[name]||0)+1;
        return beforeAdd(name,listener,options);
      };
      document.removeEventListener=(name,listener,options)=>{
        if(types.has(name))removed[name]=(removed[name]||0)+1;
        return beforeRemove(name,listener,options);
      };
      const openMenu=(node)=>{
        const event=new MouseEvent("contextmenu",{bubbles:true,cancelable:true,clientX:40,clientY:70});
        node.dispatchEvent(event);
        return {defaultPrevented:event.defaultPrevented,
          shown:!document.querySelector("#fw-unit-snap-menu").hidden};
      };
      let stats;
      try{
        const a=attachParameterSnapControls({doc:document,targets,defaultEnabled:true});
        const initial={enabled:a.enabled,descriptions:targets.map(t=>t.getAttribute("aria-description"))};
        const first=openMenu(targets[0]);
        document.querySelector("#fw-unit-snap-menu button").click();
        const afterToggle=a.enabled;
        a.dispose();a.dispose();
        const menu=document.querySelector("#fw-unit-snap-menu");
        const stale=openMenu(targets[1]);
        const restored=targets.every((t,i)=>t.title==="original "+i&&
          t.getAttribute("aria-description")==="previous "+i&&
          t.dataset.fwSnap===undefined&&!t.hasAttribute("data-fw-snap-control"));
        const b=attachParameterSnapControls({doc:document,targets,defaultEnabled:true});
        const remount=openMenu(targets[2]);
        document.querySelector("#fw-unit-snap-menu button").click();
        const afterRemountToggle=b.enabled;
        const point=new PointerEvent("pointerdown",{
          bubbles:true,cancelable:true,pointerType:"touch",pointerId:225,button:0,clientX:12,clientY:45
        });
        targets[3].dispatchEvent(point);
        b.dispose();
        await new Promise(done=>setTimeout(done,620));
        stats={initial,first,afterToggle,stale,restored,remount,
          afterRemountToggle,hiddenAfterPending:menu.hidden,
          added,removed};
      }finally{
        document.addEventListener=beforeAdd;
        document.removeEventListener=beforeRemove;
        for(const target of targets)target.remove();
      }
      return stats;
    });
    console.log("G4_SNAP_LIFECYCLE "+JSON.stringify(result));
    assert.equal(result.initial.enabled,true);
    assert.equal(result.first.defaultPrevented,true);
    assert.equal(result.first.shown,true);
    assert.equal(result.afterToggle,false);
    assert.equal(result.stale.defaultPrevented,false,
      "disposed target cannot still handle contextmenu");
    assert.equal(result.stale.shown,false,
      "disposed target cannot reopen a stale snap menu");
    assert.equal(result.restored,true,
      "disposed controller must restore original accessible descriptions and snap hints");
    assert.equal(result.remount.defaultPrevented,true);
    assert.equal(result.remount.shown,true);
    assert.equal(result.afterRemountToggle,false,
      "re-mounted target receives exactly one snap-toggle event");
    assert.equal(result.hiddenAfterPending,true,
      "disposed long-press timeout must never open a delayed menu");
    assert.deepEqual(result.added,{pointermove:2,pointerup:2,pointercancel:2,scroll:2},
      "one group of 4 document listeners per mounted controller, never per target");
    assert.deepEqual(result.removed,result.added,
      "dispose removes every owned document listener once");
    assert.deepEqual(errors,[],"snap remount must not create uncaught page errors");
  }finally{await browser?.close();server.kill();}
});
