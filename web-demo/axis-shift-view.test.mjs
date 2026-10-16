import {test} from "node:test";
import assert from "node:assert/strict";
import {axisShiftUnits,axisShiftView,axisShiftCanonical} from "./axis-shift-view.mjs";
test("Hz is valid only at linear p=1, ratio only at logarithmic p=0",()=>{
  assert.deepEqual(axisShiftUnits(0),["coordinate","percent","ratio"]);
  assert.deepEqual(axisShiftUnits(1),["coordinate","percent","hz"]);
  assert.deepEqual(axisShiftUnits(.5),["coordinate","percent"]);
  assert.throws(()=>axisShiftCanonical(350,"hz",.5,350),RangeError);
  assert.throws(()=>axisShiftView(1,"ratio",1,350),RangeError);
});
test("canonical u is unchanged across exact allowed view roundtrips",()=>{
  for(const u of [-2,-.25,0,.375,2]){
    for(const p of [0,.4,1])for(const unit of axisShiftUnits(p)){
      const v=axisShiftView(u,unit,p,350);
      assert.ok(Math.abs(axisShiftCanonical(v,unit,p,350)-u)<1e-12);
    }
  }
  assert.equal(axisShiftView(1,"hz",1,440),440);
  assert.ok(Math.abs(axisShiftCanonical(2,"ratio",0,350)-Math.log(2))<1e-12);
});
test("out-of-domain Hz and ratio are rejected instead of DSP clamping",()=>{
  assert.throws(()=>axisShiftCanonical(1000,"hz",1,350),RangeError);
  assert.throws(()=>axisShiftCanonical(-5,"ratio",0,350),RangeError);
  assert.throws(()=>axisShiftCanonical(130,"percent",.5,350),RangeError);
});
