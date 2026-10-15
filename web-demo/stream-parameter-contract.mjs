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
    ["axisShift",-4,4,"変換位置 u"],["axisSlope",-4,4,"物理傾き s"]
  ];
  for(const [key,min,max,label] of ranges){
    if(!finite(p[key])||p[key]<min||p[key]>max)
      return failed(key,label+"が現行DSPの範囲（"+min+"〜"+max+"）外です。");
  }
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
