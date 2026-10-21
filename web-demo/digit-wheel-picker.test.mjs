import {test} from "node:test";
import assert from "node:assert/strict";
import {splitWheelNumber,composeWheelNumber,WHEEL_ROW_PX} from "./digit-wheel-picker.mjs";

test("coordinated wheel preserves decimal positions without rounding Hz",()=>{
  assert.equal(WHEEL_ROW_PX,42);
  const places=[4,3,2,1,0,-1,-2];
  const digits=splitWheelNumber(87.25,{places});
  assert.deepEqual(digits,[0,0,0,8,7,2,5]);
  assert.equal(composeWheelNumber(digits,{places}),87.25);
  digits[6]=6;
  assert.equal(composeWheelNumber(digits,{places}),87.26);
});

test("signed integer picker and 9-column F-scale retain place meanings",()=>{
  const sign={signed:true,places:[2,1,0]};
  assert.deepEqual(splitWheelNumber(-5,sign),[1,0,0,5]);
  assert.equal(composeWheelNumber([0,0,0,5],sign),5);
  assert.equal(composeWheelNumber([1,1,2,9],sign),-129);
  const frequency={places:[6,5,4,3,2,1,0,-1,-2]};
  assert.equal(composeWheelNumber(splitWheelNumber(5120000,frequency),frequency),5120000);
  assert.deepEqual(splitWheelNumber(100.05,{places:[2,1,0,-1,-2]}),[1,0,0,0,5]);
});

test("invalid wheel column values are rejected, not silently repaired",()=>{
  const places=[1,0];
  assert.throws(()=>composeWheelNumber([10,0],{places}),RangeError);
  assert.throws(()=>composeWheelNumber([1],{places}),RangeError);
  assert.throws(()=>composeWheelNumber([-1,0],{places}),RangeError);
  assert.throws(()=>splitWheelNumber(NaN,{places}),RangeError);
});
