/** Browser acceptance for the opt-in editor against the exact staged Pages site. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {resolve} from 'node:path';
import puppeteer from 'puppeteer-core';
test('layout inspector is opt-in, edits live DOM, restores local changes, and previews original controls',async()=>{
  const server=spawn('python3',['-m','http.server','8793','--bind','127.0.0.1'],{cwd:resolve(process.env.WARP_WEB_ROOT||'_site'),stdio:'ignore'});
  let browser;
  try{
    browser=await puppeteer.launch({executablePath:process.env.CHROME_BIN||'/usr/bin/google-chrome',headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
    const page=await browser.newPage();
    await page.setViewport({width:1280,height:900});
    const failures=[];
    page.on('pageerror',e=>failures.push(e.message));
    await page.goto('http://127.0.0.1:8793/index.html?layout_editor=1',{waitUntil:'domcontentloaded'});
    await page.waitForSelector('#fw-layout-inspector');
    await page.waitForFunction(()=>Boolean(document.querySelector('#fw-layout-inspector')?.shadowRoot?.querySelector('[data-action=pick]')));
    assert.deepEqual(failures,[]);
    await page.evaluate(()=>document.querySelector('.brand').click());
    const selected=await page.evaluate(()=>document.querySelector('#fw-layout-inspector').shadowRoot.querySelector('#path').textContent);
    assert.match(selected,/brand/);
    await page.evaluate(()=>{
      const input=document.querySelector('#fw-layout-inspector').shadowRoot.querySelector('[data-prop=padding]');
      input.value='27';input.dispatchEvent(new Event('input',{bubbles:true}));
    });
    assert.equal(await page.$eval('.brand',el=>getComputedStyle(el).paddingTop),'27px');
    const key=await page.evaluate(()=>localStorage.getItem('frequency-warp:layout-editor:v1'));
    assert.match(key,/27px/);
    await page.reload({waitUntil:'domcontentloaded'});
    await page.waitForFunction(()=>document.querySelector('#fw-layout-inspector')?.shadowRoot);
    // The editor's own module can boot before the WebAudio app installs its handlers.
    await page.waitForFunction(()=>document.documentElement.dataset.fwBoot==='ready');
    assert.equal(await page.$eval('.brand',el=>getComputedStyle(el).paddingTop),'27px');
    // Mobile-only overrides must NOT leak into desktop dimensions.
    await page.evaluate(()=>{
      document.querySelector('.brand').click();
      const root=document.querySelector('#fw-layout-inspector').shadowRoot;
      const scope=root.querySelector('#scope');
      scope.value='mobile';scope.dispatchEvent(new Event('change',{bubbles:true}));
      const padding=root.querySelector('[data-prop=padding]');
      padding.value='37';padding.dispatchEvent(new Event('input',{bubbles:true}));
    });
    assert.equal(await page.$eval('.brand',el=>getComputedStyle(el).paddingTop),'27px');
    await page.setViewport({width:390,height:844,isMobile:true,hasTouch:true});
    assert.equal(await page.$eval('.brand',el=>getComputedStyle(el).paddingTop),'37px');
    await page.setViewport({width:1280,height:900});
    assert.equal(await page.$eval('.brand',el=>getComputedStyle(el).paddingTop),'27px');
    // Check actual CSS grid visual reordering rather than testing only the pure array helper.
    await page.evaluate(()=>{
      const root=document.querySelector('#fw-layout-inspector').shadowRoot;
      const scope=root.querySelector('#scope');
      scope.value='global';scope.dispatchEvent(new Event('change',{bubbles:true}));
      document.querySelector('.control-grid > .control').click();
      root.querySelector('[data-action=down]').click();
    });
    const orders=await page.$eval('.control-grid > .control', els=>Array.from(els).slice(0,2).map(el=>getComputedStyle(el).order));
    assert.deepEqual(orders,['1','0']);
    // Reset must restore both desktop and mobile rules, not merely the selected element.
    page.once('dialog',dialog=>dialog.accept());
    await page.evaluate(()=>document.querySelector('#fw-layout-inspector').shadowRoot.querySelector('[data-action=reset]').click());
    assert.notEqual(await page.$eval('.brand',el=>getComputedStyle(el).paddingTop),'27px');
    assert.deepEqual(await page.$eval('.control-grid > .control',els=>Array.from(els).slice(0,2).map(el=>getComputedStyle(el).order)),['0','0']);
    const resetState=await page.evaluate(()=>JSON.parse(localStorage.getItem('frequency-warp:layout-editor:v1')));
    assert.deepEqual(resetState,{version:1,global:{},mobile:{}});
    await page.evaluate(()=>document.querySelector('#fw-layout-inspector').shadowRoot.querySelector('[data-action=preview]').click());
    await page.click('#settings-open');
    assert.equal(await page.$eval('#settings-dialog',el=>el.open),true);
    await page.click('#settings-done');
    await page.goto('http://127.0.0.1:8793/index.html',{waitUntil:'domcontentloaded'});
    assert.equal(await page.$('#fw-layout-inspector'),null);
    assert.notEqual(await page.$eval('.brand',el=>getComputedStyle(el).paddingTop),'27px');
    assert.deepEqual(failures,[]);
  }finally{
    if(browser)await browser.close();
    server.kill('SIGTERM');
  }
});