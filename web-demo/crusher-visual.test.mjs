import {test} from "node:test";
import assert from "node:assert/strict";
import {frequencyFromSlider,sliderFromFrequency,holdFromFrequency,effectiveFrequency,aliasFrequency} from "./crusher-visual.mjs";
test("crusher frequency slider increases left→right and hold decreases, all rates",()=>{
  for(const rate of [8192,16000,44100,48000,96000]){
    assert.equal(holdFromFrequency(frequencyFromSlider(0,rate),rate),32);
    assert.equal(holdFromFrequency(frequencyFromSlider(1000,rate),rate),1);
    let previous=Infinity;
    for(let position=0;position<=1000;position+=25){
      const frequency=frequencyFromSlider(position,rate);
      const hold=holdFromFrequency(frequency,rate);
      assert.ok(hold<=previous,"increasing frequency must not worsen downsample ratio");
      assert.ok(hold>=1&&hold<=32);
      previous=hold;
    }
    assert.ok(Math.abs(sliderFromFrequency(rate/4,rate)-600)<=1);
    assert.equal(effectiveFrequency(rate/4,rate),rate/4);
    assert.equal(holdFromFrequency(rate*2,rate),1);
  }
});
test("theoretical alias mapping is bounded and does not invent a spectrum",()=>{
  assert.ok(Math.abs(aliasFrequency(3200,6000)-2800)<1e-8);
  assert.equal(aliasFrequency(500,6000),500);
  assert.ok(Number.isNaN(aliasFrequency(500,0)));
});
