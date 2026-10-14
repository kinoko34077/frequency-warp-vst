import {test} from "node:test";
import assert from "node:assert/strict";
import {frequencyFromSlider,sliderFromFrequency,holdFromFrequency,
  effectiveFrequency,aliasFrequency,sampleHoldImage,sampleHoldRepresentatives}
  from "./crusher-visual.mjs";

test("crusher 0..Fs Hz control: zero freezes, increasing knob decreases finite hold",()=>{
  for(const rate of [8192,16000,44100,48000,96000]){
    assert.equal(frequencyFromSlider(0,rate),0);
    assert.equal(holdFromFrequency(0,rate),0);
    assert.equal(effectiveFrequency(0,rate),0);
    assert.equal(sliderFromFrequency(0,rate),0);
    assert.equal(holdFromFrequency(frequencyFromSlider(1000,rate),rate),1);
    let previous=Infinity;
    for(let position=1;position<=1000;position+=25){
      const frequency=frequencyFromSlider(position,rate);
      const hold=holdFromFrequency(frequency,rate);
      assert.ok(hold<=previous,"larger rate cannot increase the sample holding interval");
      assert.ok(hold>=1&&hold<=1_000_000_000);
      previous=hold;
    }
    assert.ok(Math.abs(sliderFromFrequency(rate/4,rate)-880)<=1);
    assert.equal(effectiveFrequency(rate/4,rate),rate/4);
    assert.equal(holdFromFrequency(rate*2,rate),1);
    assert.ok(frequencyFromSlider(1,rate)<rate/50000,
      "low-resolution end must reach far below former Fs/32 floor");
    assert.equal(holdFromFrequency(0.1,rate),Math.round(rate/.1));
  }
});

test("ZOH spectral images: exact folded frequencies and unit-gain kernel",()=>{
  const rate=8192,hold=8,f=400,eff=rate/hold;
  const p=sampleHoldImage(f,0,rate,hold);
  const upper=sampleHoldImage(f,-1,rate,hold);
  const hi=sampleHoldImage(f,1,rate,hold);
  assert.equal(p.frequency,400);
  assert.equal(upper.frequency,624);
  assert.equal(hi.frequency,1424);
  const exact=(hz)=>Math.abs(Math.sin(Math.PI*hold*hz/rate)/
    (hold*Math.sin(Math.PI*hz/rate)));
  assert.ok(Math.abs(p.amplitude-exact(f))<1e-10);
  assert.ok(Math.abs(upper.amplitude-exact(f-eff))<1e-10);
  assert.ok(Math.abs(hi.amplitude-exact(f+eff))<1e-10);
  assert.equal(sampleHoldImage(0,0,rate,hold).amplitude,1);
  assert.ok(sampleHoldRepresentatives(f,rate,hold).length>=3);
  assert.equal(aliasFrequency(3200,6000),2800);
  assert.equal(aliasFrequency(500,6000),500);
  assert.ok(Number.isNaN(aliasFrequency(500,0)));
});
