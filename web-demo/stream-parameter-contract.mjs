// Explicitly mirror the accepted shared Rust Stream creation/update gates.
// This is a UI preflight, NOT a substitute for a successful AudioWorklet ACK.
const finite=(v)=>typeof v==="number"&&Number.isFinite(v);
const failed=(field,message)=>({ok:false,field,message});
export function validateStreamSettings(p){
  if(!p||typeof p!=="object")return failed("settings","DSP設定がありません。");
  const ranges=[
    ["low",0.001,20000,"処理下限 L"],["high",0.001,20000,"処理上限 H"],
    ["axisPivot",0,20000,"物理起点 P"],["aMinHz",0.001,20000,"A抽出下限"],
    ["pitchRatio",0.000000000001,4,"ピッチ比 r"],["carrierHz",-1,20000,"搬送波 c"],
    ["axisShift",-4,4,"変換位置 u"],["axisSlope",-4,4,"物理傾き s"],
    // Each later Rust stream setter validates independently after set_ext.
    // Reject the full snapshot BEFORE any live stream mutation can begin.
    ["curvature",0,1,"曲率"],["invert",0,1,"反転率"],
    ["aReverb",0,1,"A残響"],["zeroReflectGain",0,1,"反射合成率"],
    ["zeroReflectDecay",0,1,"反射減衰率"]
  ];
  for(const [key,min,max,label] of ranges){
    if(!finite(p[key])||p[key]<min||p[key]>max)
      return failed(key,label+"が現行DSPの範囲（"+min+"〜"+max+"）外です。");
  }
  // Rust u32 setters do not preserve invalid, fractional or negative UI
  // values. Reject instead of silently coercing via a WebAssembly argument.
  const integers=[
    ["qualityIndex",0,2,"FFT品質"],["engine",0,3,"処理エンジン"],
    ["zeroMode",0,2,"ゼロ周波数モード"],["aBandBins",1,8,"A抽出帯域"],
    ["aQuality",0,100,"A再合成精細度"],["crusherHold",0,1000000000,"ビットクラッシャー保持長"]
  ];
  for(const [key,min,max,label] of integers){
    if(!Number.isSafeInteger(p[key])||p[key]<min||p[key]>max)
      return failed(key,label+"が現行DSPの整数範囲（"+min+"〜"+max+"）外です。");
  }
  if(![4,8].includes(p.hopDiv))
    return failed("hopDiv","処理hopは4または8にしてください。");
  if(p.crusherBits!==0&&
     (!Number.isSafeInteger(p.crusherBits)||p.crusherBits<2||p.crusherBits>16))
    return failed("crusherBits","量子化bit数はOFF（0）または2〜16にしてください。");
  if(!["fold-h","fold-l","reciprocal","blend"].includes(p.mode))
    return failed("mode","反転進行の種類が現行DSPに非対応です。");
  if(p.outside!=="pass"&&p.outside!=="kill")
    return failed("outside","L/H外側の処理が現行DSPに非対応です。");
  if(p.low>=p.high)return failed("low","処理周波数は L < H が必要です。");
  const rate=p.sampleRate;
  if(!finite(rate)||rate<=0)return failed("sampleRate","処理サンプルレートが不正です。");
  if(p.high>=rate/2)return failed("high","上限Hは現在のサンプルレートのナイキスト周波数未満にしてください。");
  // Rust checks these *even with rationalEnabled=false*: both are sent as
  // distinct fields to create_ext/set_ext + set_transform. Never neutralize,
  // clamp or secretly change the theoretical F to make a rejected packet pass.
  if(!finite(p.shiftHz)||Math.abs(p.shiftHz)>20000)
    return failed("shiftHz","理論上のシフト Δ が±20,000Hzを超えています。20kHz超の実処理は将来のオーバーサンプリング領域です。現在の音声処理へは未反映です。");
  if(!finite(p.axisReference)||p.axisReference<1||p.axisReference>20000)
    return failed("axisReference",p.axisReference>20000?
      "基準周波数 R が20,000Hz超です。これは将来のオーバーサンプリング領域で、現行DSPには適用されません（理論Fは保持）。":
      "基準周波数 R が1Hz未満です。グラフ表示は維持できますが、現行DSPには適用されません（対応1〜20,000Hz）。");
  return {ok:true,field:null,message:""};
}


/**
 * Build the EFFECTIVE, Rust-compatible audio snapshot without mutating the
 * user's theoretical controls or graph. Sub-1 Hz reference frequencies are
 * displayable but Rust's transform setter currently accepts >=1 Hz.
 * Treat this one known capability gap as a visible warning, not a startup
 * failure; all other invalid numeric/semantic fields remain fail-closed.
 */
export function prepareStreamSettings(theoretical){
  if(!theoretical || typeof theoretical!=="object")
    return {settings:theoretical,warnings:[],...validateStreamSettings(theoretical)};
  const settings={...theoretical};
  const warnings=[];
  if(finite(settings.axisReference) &&
     settings.axisReference>=0 && settings.axisReference<1){
    settings.axisReference=1;
    warnings.push("基準周波数 R は現行DSPでは1 Hzからです。指定した"+
      theoretical.axisReference+" Hzは表示・入力に保持し、音声処理には1 Hzを適用します。");
  }
  return {settings,warnings,...validateStreamSettings(settings)};
}
