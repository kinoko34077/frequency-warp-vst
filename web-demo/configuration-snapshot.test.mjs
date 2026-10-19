import {test} from "node:test";
import assert from "node:assert/strict";
import {createSoundConfiguration,validateSoundConfiguration} from "./configuration-snapshot.mjs";

function fixture(){
  const harmonic={F:350,m:4,n:-3,q:1,r:1,carrier:350};
  const audio={low:20,high:16000,curvature:1,invert:0,axisPivot:350,
    axisSlope:1,axisShift:0,wet:1,zeroReflectGain:1,zeroReflectDecay:0,
    aMinHz:20,aReverb:0,aBandBins:1,aQuality:0,crusherRateHz:12000,
    crusherBits:0,axisReference:350,shiftHz:-262.5,qualityIndex:0,
    engine:1,hopDiv:4,mode:"reciprocal",outside:"pass",sampleRate:48000};
  return {
    sourceToken:1,sampleRate:48000,harmonic,
    audio,values:{
      low:20,high:16000,curvature:1,invert:0,axisPivot:350,
      axisSlope:1,axisShift:0,wet:1,zeroReflectGain:1,zeroReflectDecay:0,
      aMinHz:20,aReverb:0,aBandBins:1,aQuality:0,crusherRateHz:12000,
      crusherBits:0,manualCrusherBits:8
    },
    selectors:{mode:"reciprocal",outside:"pass",quality:"eco",overlap:"4",
      engine:"1",pivotLinkTarget:"H",harmonicCount:"5"},
    flags:{engineAuto:false,ringEnabled:false,rationalEnabled:false,
      crusherEnabled:false,carrierLink:false,harmonicPivotLink:false,
      pivotFollowLow:false,rationalEnabledByLink:false}
  };
}
test("full-precision two-slot configuration is immutable and independent",()=>{
  const a=fixture();a.harmonic.F=350.123456789;a.audio.axisReference=a.harmonic.F;
  a.audio.shiftHz=-3*a.harmonic.F/4;
  const frozen=createSoundConfiguration(a);
  a.harmonic.F=9999;a.values.low=100;a.audio.low=100;
  assert.equal(frozen.harmonic.F,350.123456789);
  assert.equal(frozen.values.low,20);
  assert.equal(frozen.audio.low,20);
  assert.ok(Object.isFrozen(frozen.audio));
  assert.ok(Object.isFrozen(frozen));
  const b=fixture();b.values.low=40;b.audio.low=40;
  const newer=createSoundConfiguration(b);
  assert.equal(frozen.values.low,20);assert.equal(newer.values.low,40);
});
test("invalid/foreign source snapshot is rejected before any restoration",()=>{
  const original=fixture(),a=createSoundConfiguration(original);
  assert.throws(()=>validateSoundConfiguration(a,{sourceToken:2,sampleRate:48000}),/another audio source/);
  assert.throws(()=>validateSoundConfiguration(a,{sourceToken:1,sampleRate:44100}),/sample rate changed/);
  const invalid=fixture();invalid.values.axisSlope=Infinity;
  assert.throws(()=>createSoundConfiguration(invalid),/axisSlope/);
  const wrongRatio=fixture();wrongRatio.harmonic.r=1.3;
  assert.throws(()=>createSoundConfiguration(wrongRatio),/DSP\/harmonic canonical mismatch/);
  const badH=fixture();
  badH.flags.harmonicPivotLink=true;
  assert.throws(()=>createSoundConfiguration(badH),/F\/H to physical P link/);
  const invalidCrusher=fixture();invalidCrusher.flags.crusherEnabled=true;
  assert.throws(()=>createSoundConfiguration(invalidCrusher),/crusher enablement/);
});
test("canonical direct F/P and derived H/P link have different invariants",()=>{
  const f=fixture();f.flags.harmonicPivotLink=true;f.flags.rationalEnabled=true;
  f.flags.rationalEnabledByLink=true;f.selectors.pivotLinkTarget="F";
  assert.equal(createSoundConfiguration(f).values.axisPivot,350);
  f.selectors.pivotLinkTarget="H";
  f.values.axisPivot=87.5;f.audio.axisPivot=87.5;
  assert.equal(createSoundConfiguration(f).values.axisPivot,87.5);
});
