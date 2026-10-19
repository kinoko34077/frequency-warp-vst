/** UX-T2: project playback state onto a truthful, compact, graph-adjacent cue.
 * An AudioWorklet parameter ACK is proof of DSP acceptance, not a measured
 * spectrum or an assurance that the listener currently hears Wet.
 */
export function auditionFeedbackView({loaded=false,player=null,wetMix=1}={}){
  if(!loaded)return {phase:"idle",text:"音源未選択 · グラフは理論値"};
  if(!player)return {phase:"stopped",text:"停止中 · グラフは理論値（音声未適用）"};
  if(player.directDry||player.mode==="dry"||!(wetMix>0))
    return {phase:"dry",text:"原音のみ試聴中 · 変換音は現在聴こえません"};
  const feedback=player.feedback?.current;
  if(!feedback)return {phase:"starting",text:"変換音起動中 · DSPの反映未確認"};
  switch(feedback.phase){
    case "pending":
      return {phase:"pending",text:"DSPへ設定要求中 · 最新変更の反映待ち"};
    case "rebuilding":
      return {phase:"rebuilding",text:"DSPを切替中 · 最新変更の反映待ち"};
    case "rejected":
      return {phase:"rejected",text:"設定未反映 · 値を確認してください"};
    case "failed":
      return {phase:"failed",text:"変換処理エラー · 最新設定は未反映"};
    case "applied":
      if(feedback.requestedRevision>0&&
        feedback.appliedRevision===feedback.requestedRevision)
        return {phase:"applied",text:"DSPが最新設定を受理 · 実音の測定ではありません"};
      return {phase:"ready",text:"DSP初期設定で起動 · 実音の測定ではありません"};
    default:
      return {phase:"starting",text:"変換音起動中 · DSPの反映未確認"};
  }
}
