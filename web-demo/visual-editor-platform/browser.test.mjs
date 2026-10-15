import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {resolve} from 'node:path';
import puppeteer from 'puppeteer-core';
test('v2 stable-ID opt-in editor persists and survives DOM regeneration while audio controls remain available',async()=>{
 const server=spawn('python3',['-m','http.server','8798','--bind','127.0.0.1'],{cwd:resolve(process.env.WARP_WEB_ROOT||'_site'),stdio:'ignore'});
 let browser;
 try{
   browser=await puppeteer.launch({executablePath:process.env.CHROME_BIN||'/usr/bin/google-chrome',headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
   const page=await browser.newPage(),errors=[];
   page.on('pageerror',e=>errors.push(e.message));
   await page.goto('http://127.0.0.1:8798/index.html',{waitUntil:'domcontentloaded'});
   assert.equal(await page.$('#visual-editor-v2'),null);
   await page.goto('http://127.0.0.1:8798/index.html?visual_editor_v2=1',{waitUntil:'domcontentloaded'});
   await page.waitForFunction(()=>Boolean(document.querySelector('#visual-editor-v2')?.shadowRoot?.querySelector('#apply')));
   assert.equal(await page.$('#fw-layout-inspector'),null);
   await page.evaluate(()=>{
     const root=document.querySelector('#visual-editor-v2').shadowRoot;
     root.querySelector('#node').value='player.title';
     root.querySelector('#prop').value='font-size';
     root.querySelector('#value').value='27px';
     root.querySelector('#apply').click();
   });
   await page.waitForFunction(()=>getComputedStyle(document.querySelector('#player-title')).fontSize==='27px');
   const saved=await page.evaluate(()=>localStorage.getItem('frequency-warp:visual-editor-v2:v1'));
   assert.match(saved,/27px/);
   await page.evaluate(()=>{
     const original=document.querySelector('#player-title');
     original.replaceWith(original.cloneNode(true));
   });
   assert.equal(await page.$eval('#player-title',e=>getComputedStyle(e).fontSize),'27px');
   await page.evaluate(()=>document.querySelector('#visual-editor-v2').shadowRoot.querySelector('#undo').click());
   await page.waitForFunction(()=>getComputedStyle(document.querySelector('#player-title')).fontSize!=='27px');
   await page.evaluate(()=>document.querySelector('#visual-editor-v2').shadowRoot.querySelector('#redo').click());
   await page.waitForFunction(()=>getComputedStyle(document.querySelector('#player-title')).fontSize==='27px');
   await page.reload({waitUntil:'domcontentloaded'});
   await page.waitForFunction(()=>document.querySelector('#visual-editor-v2')?.shadowRoot);
   assert.equal(await page.$eval('#player-title',e=>getComputedStyle(e).fontSize),'27px');
   await page.evaluate(()=>document.querySelector('#visual-editor-v2').shadowRoot.querySelector('#preview').click());
   await page.click('#settings-open');
   assert.equal(await page.$eval('#settings-dialog',e=>e.open),true);
   await page.goto('http://127.0.0.1:8798/index.html',{waitUntil:'domcontentloaded'});
   assert.equal(await page.$('#visual-editor-v2'),null);
   assert.notEqual(await page.$eval('#player-title',e=>getComputedStyle(e).fontSize),'27px');
   assert.deepEqual(errors,[]);
 }finally{if(browser)await browser.close();server.kill('SIGTERM');}
});
