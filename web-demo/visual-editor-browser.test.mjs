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
    assert.equal(await page.$eval('.brand',el=>getComputedStyle(el).paddingTop),'27px');
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