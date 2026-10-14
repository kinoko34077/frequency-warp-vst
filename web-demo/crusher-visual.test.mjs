import {test} from "node:test";
import assert from "node:assert/strict";
import {MAX_CRUSHER_HOLD,frequencyFromSlider,sliderFromFrequency,holdFromFrequency,effectiveFrequency,aliasFrequency,zohImageMagnitude,sampleHoldImages} from "./crusher-visual.mjs";
test("crusher frequency slider increases left→right and hold decreases, all rates",()=>{
  for(const rate of [8192,16000,44100,48000,96000]){
    assert.equal(holdFromFrequency(frequencyFromSlider(0,rate),rate),0);
    assert.equal(holdFromFrequency(frequencyFromSlider(1,rate),rate),MAX_CRUSHER_HOLD);
    assert.equal(holdFromFrequency(frequencyFromSlider(1000,rate),rate),1);
    let previous=MAX_CRUSHER_HOLD;
    for(let position=1;position<=1000;position+=25){
      const frequency=frequencyFromSlider(position,rate);
      const hold=holdFromFrequency(frequency,rate);
      assert.ok(hold<=previous,"increasing frequency must not worsen downsample ratio");
      assert.ok(hold>=1&&hold<=MAX_CRUSHER_HOLD);
      previous=hold;
    }
    assert.ok(Math.abs(sliderFromFrequency(rate/4,rate)-900)<=2);
    assert.equal(effectiveFrequency(rate/4,rate),rate/4);
    assert.equal(holdFromFrequency(rate*2,rate),1);
  }
});
test("theoretical alias mapping is bounded and does not invent a spectrum",()=>{
  assert.ok(Math.abs(aliasFrequency(3200,6000)-2800)<1e-8);
  assert.equal(aliasFrequency(500,6000),500);
  assert.equal(aliasFrequency(500,0),0);
  assert.deepEqual(sampleHoldImages(500,8192,0),[{hz:0,gain:1,order:0,freeze:true}]);
});
