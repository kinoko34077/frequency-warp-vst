import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {resolve} from 'node:path';
import puppeteer from 'puppeteer-core';

test('Inspector minimize, drag, cut/copy/paste context and Settings debug mode',async()=>{
  const server=spawn('python3',['-m','http.server','8794','--bind','127.0.0.1'],{cwd:resolve(process.env.WARP_WEB_ROOT||'_site'),stdio:'ignore'});
  let browser;
  try{
    browser=await puppeteer.launch({executablePath:process.env.CHROME_BIN||'/usr/bin/google-chrome',headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
    const page=await browser.newPage();
    await page.setViewport({width:1280,height:900});
    const errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.goto('http://127.0.0.1:8794/index.html',{waitUntil:'domcontentloaded'});
    await page.waitForFunction(()=>document.documentElement.dataset.fwBoot==='ready');
    assert.equal(await page.$('#fw-layout-inspector'),null,'Normal site must not mount the inspector');
    await page.click('#settings-open');
    assert.equal(await page.$eval('#debug-mode',el=>el.checked),false);
    await page.$eval('#debug-mode',el=>{el.checked=true;el.dispatchEvent(new Event('change',{bubbles:true}));});
    await page.waitForFunction(()=>document.querySelector('#fw-layout-inspector')?.shadowRoot?.querySelector('#fw-context-menu'));
    assert.equal(await page.$eval('#debug-mode',el=>el.checked),true);
    await page.click('#settings-done');

    // Regression: original .collapsed .panel shadow selector did not apply.
    await page.evaluate(()=>document.querySelector('#fw-layout-inspector').shadowRoot.querySelector('[data-action=collapse]').click());
    const hiddenActions=await page.evaluate(()=>{
      const h=document.querySelector('#fw-layout-inspector');
      return h.classList.contains('collapsed')&&getComputedStyle(h.shadowRoot.querySelector('.actions')).display==='none';
    });
    assert.equal(hiddenActions,true,'minimize must visually hide child controls');
    await page.evaluate(()=>document.querySelector('#fw-layout-inspector').shadowRoot.querySelector('[data-action=collapse]').click());
    assert.equal(await page.evaluate(()=>getComputedStyle(document.querySelector('#fw-layout-inspector').shadowRoot.querySelector('.actions')).display),'flex');

    await page.evaluate(()=>{
      window.__fwDragEvents=[];
      const head=document.querySelector('#fw-layout-inspector').shadowRoot.querySelector('.head');
      for(const type of ['pointerdown','pointermove','pointerup'])head.addEventListener(type,e=>window.__fwDragEvents.push({
        type,button:e.button,pointerId:e.pointerId,clientX:e.clientX,clientY:e.clientY,target:e.target.tagName
      }),true);
    });
    const before=await page.$eval('#fw-layout-inspector',el=>({x:el.getBoundingClientRect().left,y:el.getBoundingClientRect().top}));
    const head=await page.evaluate(()=>{
      const r=document.querySelector('#fw-layout-inspector').shadowRoot.querySelector('.head').getBoundingClientRect();
      return {x:r.left+55,y:r.top+16};
    });
    await page.mouse.move(head.x,head.y);
    await page.mouse.down();
    await page.mouse.move(head.x-80,head.y-45,{steps:7});
    await page.mouse.up();
    const after=await page.$eval('#fw-layout-inspector',el=>({x:el.getBoundingClientRect().left,y:el.getBoundingClientRect().top}));
    assert.ok(before.x-after.x>30 && before.y-after.y>15,'drag must move inspector '+JSON.stringify({before,after,head,trace:await page.evaluate(()=>window.__fwDragEvents),errors}));
    assert.match(await page.evaluate(()=>localStorage.getItem('frequency-warp:inspector-position:v1')),/x/);

    // Windows-style mouse context menu / static copy and paste.
    await page.click('.brand',{button:'right'});
    assert.equal(await page.evaluate(()=>document.querySelector('#fw-layout-inspector').shadowRoot.querySelector('#fw-context-menu').hidden),false);
    await page.evaluate(()=>document.querySelector('#fw-layout-inspector').shadowRoot.querySelector('[data-context=copy]').click());
    await page.evaluate(()=>document.querySelector('.brand').click());
    await page.evaluate(()=>document.querySelector('#fw-layout-inspector').shadowRoot.querySelector('[data-action=preview]').click());
    await page.evaluate(()=>document.querySelector('#fw-layout-inspector').shadowRoot.querySelector('[data-action=pick]').click());
    await page.click('.brand',{button:'right'});
    await page.evaluate(()=>document.querySelector('#fw-layout-inspector').shadowRoot.querySelector('[data-context=paste]').click());
    assert.equal(await page.$$eval('.header > .brand',items=>items.length),2,'paste must duplicate a static node');
    assert.equal(await page.$eval('.header > .brand[data-fw-inspector-copy]',el=>el.hasAttribute('data-fw-inspector-copy')),true);
    // Interactive controls must not be cloned: no duplicate IDs allowed.
    await page.click('#settings-open',{button:'right'});
    assert.equal(await page.evaluate(()=>document.querySelector('#fw-layout-inspector').shadowRoot.querySelector('[data-context=copy]').disabled),true);

    // Live widget cut/paste uses CSS order without detaching the existing controls.
    await page.evaluate(()=>{
      const item=document.querySelector('.control-grid > .control');
      item.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:120,clientY:220}));
      document.querySelector('#fw-layout-inspector').shadowRoot.querySelector('[data-context=cut]').click();
      const target=document.querySelectorAll('.control-grid > .control')[1];
      target.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:120,clientY:220}));
      document.querySelector('#fw-layout-inspector').shadowRoot.querySelector('[data-context=paste]').click();
    });
    assert.deepEqual(await page.evaluate(()=>[...document.querySelectorAll('.control-grid > .control')].slice(0,2).map(e=>getComputedStyle(e).order)),['1','0']);
    assert.ok(await page.$('#axis-shift'),'interactive range DOM still mounted');

    // Actual long touch invokes the same menu.
    await page.evaluate(()=>document.querySelector('.logo').dispatchEvent(new PointerEvent('pointerdown',{
      bubbles:true,pointerType:'touch',pointerId:19,clientX:110,clientY:160
    })));
    await new Promise(r=>setTimeout(r,610));
    assert.equal(await page.evaluate(()=>document.querySelector('#fw-layout-inspector').shadowRoot.querySelector('#fw-context-menu').hidden),false);
    await page.evaluate(()=>document.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,pointerType:'touch',pointerId:19})));

    // Debug-mode OFF must hide the editor and restore normal settings UI without reload.
    await page.evaluate(()=>document.querySelector('#fw-layout-inspector').shadowRoot.querySelector('[data-action=preview]').click());
    await page.click('#settings-open');
    await page.$eval('#debug-mode',el=>{el.checked=false;el.dispatchEvent(new Event('change',{bubbles:true}));});
    assert.equal(await page.$eval('#fw-layout-inspector',el=>el.hidden),true);
    await page.click('#settings-done');
    await page.reload({waitUntil:'domcontentloaded'});
    await page.waitForFunction(()=>document.documentElement.dataset.fwBoot==='ready');
    assert.equal(await page.$('#fw-layout-inspector'),null);
    assert.equal(await page.$eval('#debug-mode',el=>el.checked),false);
    assert.deepEqual(errors,[]);
  }finally{
    if(browser)await browser.close();
    server.kill('SIGTERM');
  }
});