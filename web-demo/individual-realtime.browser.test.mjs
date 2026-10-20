import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import puppeteer from 'puppeteer-core';
const root=process.env.WARP_WEB_ROOT||'_site';
function wav(){
 const rate=16000,samples=rate,buf=Buffer.alloc(44+samples*2);
 buf.write('RIFF',0);buf.writeUInt32LE(buf.length-8,4);buf.write('WAVE',8);
 buf.write('fmt ',12);buf.writeUInt32LE(16,16);buf.writeUInt16LE(1,20);
 buf.writeUInt16LE(1,22);buf.writeUInt32LE(rate,24);buf.writeUInt32LE(rate*2,28);
 buf.writeUInt16LE(2,32);buf.writeUInt16LE(16,34);buf.write('data',36);
 buf.writeUInt32LE(samples*2,40);
 for(let i=0;i<samples;i++)buf.writeInt16LE(Math.round(8000*Math.sin(2*Math.PI*307.137*i/rate)),44+i*2);
 return buf;
}
test('real Chrome: settings A K window uses normal Rust 128-frame realtime Wet, legacy B preserved',async()=>{
 const srv=spawn('python3',['-m','http.server','8779','--bind','127.0.0.1'],{cwd:root,stdio:'ignore'});
 let browser;
 try{
  browser=await puppeteer.launch({executablePath:process.env.CHROME_BIN||'/usr/bin/google-chrome',headless:true,
   args:['--no-sandbox','--disable-dev-shm-usage','--autoplay-policy=no-user-gesture-required']});
  const page=await browser.newPage(),errors=[];
  page.on('pageerror',e=>errors.push(String(e.message)));
  await page.goto('http://127.0.0.1:8779/index.html',{waitUntil:'domcontentloaded'});
  await page.waitForFunction(()=>document.documentElement.dataset.fwBoot==='ready',{timeout:25000});
  assert.equal(await page.$('#lab-port-preview'),null);
  await page.click('#settings-open');
  assert.equal(await page.$eval('#settings-dialog',e=>e.open),true);
  await page.$eval('#engine-auto',e=>{e.checked=false;e.dispatchEvent(new Event('change',{bubbles:true}));});
  await page.$eval('#engine',e=>{e.value='0';e.dispatchEvent(new Event('change',{bubbles:true}));});
  assert.equal(await page.$eval('#individual-enabled',e=>e.disabled),false);
  await page.$eval('#individual-enabled',e=>{e.checked=true;e.dispatchEvent(new Event('input',{bubbles:true}));});
  await page.$eval('#individual-cycles',e=>{e.value='-1';e.dispatchEvent(new Event('input',{bubbles:true}));});
  assert.equal(await page.$eval('#individual-cycle-value',e=>e.textContent),'0.5周期');
  await page.click('#settings-done');
  const data=wav().toString('base64');
  await page.evaluate(encoded=>{
   const bytes=Uint8Array.from(atob(encoded),x=>x.charCodeAt(0));
   const f=new File([bytes],'native-realtime-k.wav',{type:'audio/wav'});
   const dt=new DataTransfer();dt.items.add(f);
   const input=document.querySelector('#audio-file');input.files=dt.files;
   input.dispatchEvent(new Event('change',{bubbles:true}));
  },data);
  await page.waitForFunction(()=>!document.querySelector('#play-wet').disabled,{timeout:24000});
  await page.click('#play-wet');
  await page.waitForFunction(()=>/稼働中|動作中/.test(document.querySelector('#rt-indicator')?.textContent||''),{timeout:25000});
  assert.match(await page.$eval('#rt-indicator',e=>e.textContent),/Rust/);
  await page.click('#settings-open');
  await page.$eval('#engine',e=>{e.value='1';e.dispatchEvent(new Event('change',{bubbles:true}));});
  assert.equal(await page.$eval('#individual-enabled',e=>e.disabled),true);
  assert.equal(await page.$eval('#individual-enabled',e=>e.checked),true,'retain configuration for A mode');
  await page.click('#settings-done');
  await page.waitForFunction(()=>/稼働中|動作中/.test(document.querySelector('#rt-indicator')?.textContent||''),{timeout:25000});
  assert.deepEqual(errors,[]);
  await page.click('#stop');
 }finally{await browser?.close();srv.kill('SIGTERM');}
});
