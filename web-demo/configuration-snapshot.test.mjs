import {test} from "node:test";
import assert from "node:assert/strict";
import {createSoundConfiguration,validateSoundConfiguration,effectiveComparisonAudio,verifyComparisonAudio,SHARED_SETTINGS_AUDIO_KEYS} from "./configuration-snapshot.mjs";

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
  const b=fixture();b.values.low=40;b.audio.low=40;b.audio.aMinHz=40;
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

test("A/B restores per-slot effects while global Settings remain current",()=>{
  const saved=fixture().audio,current={...saved,
    mode:"fold-h",outside:"kill",qualityIndex:2,hopDiv:8,engine:0,
    aMinHz:90,aQuality:35,aBandBins:2,aReverb:.5,
    low:90,high:11000,wet:.33};
  const result=effectiveComparisonAudio(saved,current);
  for(const key of SHARED_SETTINGS_AUDIO_KEYS){
    assert.equal(result[key],current[key],key+" remains global");
  }
  for(const key of ["low","high","wet","pitchRatio","shiftHz","axisPivot"]){
    assert.equal(result[key],saved[key],key+" is per-slot");
  }
  assert.equal(result.aMinHz,saved.low,"A uses saved common L, not global cutoff");
  assert.notEqual(result,saved);
  assert.equal(saved.mode,"reciprocal");
  verifyComparisonAudio(result,saved);
  assert.throws(()=>verifyComparisonAudio({...result,wet:.5},saved),/wet/);
});

test("legacy A/B Engine A minimum is migrated to the saved per-slot L",()=>{
  const current=fixture();
  current.values.low=12.345;current.values.aMinHz=900;
  current.audio.low=12.345;current.audio.aMinHz=900;
  const captured=createSoundConfiguration(current);
  assert.equal(captured.audio.aMinHz,12.345);
  assert.equal(Object.hasOwn(captured.values,"aMinHz"),false,
    "new snapshots do not store a second A cutoff");

  // A snapshot from the old page can still carry a different legacy ABI value.
  const legacy=structuredClone(createSoundConfiguration(fixture()));
  legacy.values.low=12.345;legacy.values.aMinHz=900;
  legacy.audio.low=12.345;legacy.audio.aMinHz=900;
  validateSoundConfiguration(legacy);
  const actual=effectiveComparisonAudio(legacy.audio,{...legacy.audio,low:90,aMinHz:90});
  assert.equal(actual.low,12.345);
  assert.equal(actual.aMinHz,12.345);
  verifyComparisonAudio(actual,legacy.audio);
});

test("A/B transport is immutable and optional for older sound snapshots",()=>{
  const legacy=createSoundConfiguration(fixture());
  assert.equal(legacy.transport,undefined);
  assert.doesNotThrow(()=>validateSoundConfiguration(legacy));

  const input={...fixture(),transport:{mode:"wet",position:3.25,duration:12}};
  const saved=createSoundConfiguration(input);
  input.transport.position=9;
  assert.deepEqual(saved.transport,{mode:"wet",position:3.25,duration:12});
  assert.ok(Object.isFrozen(saved.transport));
  assert.throws(()=>createSoundConfiguration({...fixture(),transport:{
    mode:"pause",position:3,duration:12
  }}),/transport/);
  assert.throws(()=>createSoundConfiguration({...fixture(),transport:{
    mode:"dry",position:12.1,duration:12
  }}),/transport/);
});
