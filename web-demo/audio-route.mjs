/** Exclusive gain routing between direct WebAudio and HTMLMedia bridge.
 * During mediaElement.play() startup, the bridge stays nearly inaudible.
 */
export function switchAudioRoute(player,context,media){
  const now=context.currentTime;
  player.directRoute.gain.cancelScheduledValues(now);
  player.bridgeRoute?.gain.cancelScheduledValues(now);
  player.directRoute.gain.setTargetAtTime(media?0:1,now,.008);
  if(player.bridgeRoute)player.bridgeRoute.gain.setTargetAtTime(media?1:0.0001,now,.008);
  player.outputRoute=media?"media":"direct";
  if(player.mediaElement)player.mediaElement.dataset.route=player.outputRoute;
}
