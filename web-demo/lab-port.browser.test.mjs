import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import puppeteer from 'puppeteer-core';
const root=process.env.WARP_WEB_ROOT||'_site';
function wav(duration=.55,rate=16000){
 const samples=Math.round(duration*rate),buf=Buffer.alloc(44+samples*2);
 buf.write('RIFF',0);buf.writeUInt32LE(buf.length-8,4);buf.write('WAVE',8);
 buf.write('fmt ',12);buf.writeUInt32LE(16,16);buf.writeUInt16LE(1,20);
 buf.writeUInt16LE(1,22);buf.writeUInt32LE(rate,24);buf.writeUInt32LE(rate*2,28);
 buf.writeUInt16LE(2,32);buf.writeUInt16LE(16,34);buf.write('data',36);
 buf.writeUInt32LE(samples*2,40);
 for(let i=0;i<samples;i++)
  buf.writeInt16LE(Math.round(5500*Math.sin(2*Math.PI*347.137*i/rate)),44+2*i);
 return buf;
}
test('real Chrome: native frequency-warp engines preserved while Lab slider and actual Worker render play',async()=>{
 const server=spawn('python3',['-m','http.server','8779','--bind','127.0.0.1'],{cwd:root,stdio:'ignore'});
 let browser;
 try{
  browser=await puppeteer.launch({executablePath:process.env.CHROME_BIN||'/usr/bin/google-chrome',
   headless:true,args:['--no-sandbox','--disable-dev-shm-usage','--autoplay-policy=no-user-gesture-required']});
  const page=await browser.newPage();
  const errors=[];
  page.on('pageerror',e=>errors.push(String(e.message)));
  const url='http://127.0.0.1:8779/index.html';
  await page.goto(url,{waitUntil:'domcontentloaded',timeout:20000});
  await page.waitForFunction(()=>document.documentElement.dataset.fwBoot==='ready',{timeout:20000});
  assert.equal(await page.$eval('#lab-port-individual',e=>e.checked),false);
  assert.equal(await page.$eval('#lab-port-cycles-field',e=>e.hidden),true);
  const before=await page.$eval('#engine',e=>e.options.length);
  await page.$eval('#lab-port-individual',e=>{e.checked=true;e.dispatchEvent(new Event('input',{bubbles:true}));});
  assert.equal(await page.$eval('#lab-port-cycles-field',e=>e.hidden),false);
  await page.$eval('#lab-port-cycles',e=>{e.value='-1';e.dispatchEvent(new Event('input',{bubbles:true}));});
  assert.equal(await page.$eval('#lab-port-cycles-output',e=>e.textContent),'0.5周期');
  await page.$eval('#lab-port-backend',e=>{e.value='wsola';e.dispatchEvent(new Event('input',{bubbles:true}));});
  assert.equal(await page.$eval('#lab-port-short',e=>e.disabled),false);
  assert.equal(await page.$eval('#lab-port-long',e=>e.disabled),true);
  await page.$eval('#lab-port-backend',e=>{e.value='dual';e.dispatchEvent(new Event('input',{bubbles:true}));});
  assert.equal(await page.$eval('#lab-port-long',e=>e.disabled),false);
  const [orig,after]=await page.evaluate(()=>[
   document.querySelector('#play-wet').disabled,
   document.querySelector('#engine').options.length]);
  assert.equal(after,before);
  assert.equal(orig,true,'no file must not enable native Rust audition');
  const file=await page.$('#audio-file');
  const data=wav().toString('base64');
  await page.evaluate(async encoded=>{
   const bytes=Uint8Array.from(atob(encoded),c=>c.charCodeAt(0));
   const f=new File([bytes],'lab-port-test.wav',{type:'audio/wav'});
   const input=document.querySelector('#audio-file'),dt=new DataTransfer();
   dt.items.add(f);input.files=dt.files;input.dispatchEvent(new Event('change',{bubbles:true}));
  },data);
  await page.waitForFunction(()=>!document.querySelector('#lab-port-preview').disabled,{timeout:25000});
  await page.$eval('#lab-port-speed',e=>{e.value='.8';e.dispatchEvent(new Event('input',{bubbles:true}));});
  await page.$eval('#lab-port-pitch',e=>{e.value='3';e.dispatchEvent(new Event('input',{bubbles:true}));});
  await page.click('#lab-port-preview');
  await page.waitForFunction(()=>{
   const text=document.querySelector('#lab-port-status').textContent;
   return text.includes('試聴中')||text.includes('失敗');
  },{timeout:30000});
  const text=await page.$eval('#lab-port-status',e=>e.textContent);
  assert.match(text,/試聴中/,text+' | '+errors.join('; '));
  assert.equal(await page.$eval('#engine',e=>e.options.length),before);
  await page.click('#lab-port-stop');
  assert.equal(await page.$eval('#lab-port-stop',e=>e.disabled),true);
  // Real native Warp/WASM offline DSP must complete BEFORE the selected Lab
  // module processes the same bounded sample excerpt. Do not just show a fake
  // checkbox or silently process the original signal.
  await page.$eval('#lab-port-apply-warp',e=>{
   e.checked=true;e.dispatchEvent(new Event('input',{bubbles:true}));
  });
  await page.click('#lab-port-preview');
  await page.waitForFunction(()=>{
   const text=document.querySelector('#lab-port-status').textContent;
   return text.includes('Rust Warp→')||text.includes('失敗');
  },{timeout:45000});
  const sequential=await page.$eval('#lab-port-status',e=>e.textContent);
  assert.match(sequential,/試聴中 · Rust Warp→/,sequential+' | '+errors.join('; '));
  await page.click('#lab-port-stop');
  assert.equal(await page.$eval('#engine',e=>e.options.length),before);

  assert.deepEqual(errors,[],'unexpected page module errors');
 }finally{await browser?.close();server.kill('SIGTERM');}
});
