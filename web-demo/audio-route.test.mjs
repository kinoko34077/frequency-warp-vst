import {test} from "node:test";
import assert from "node:assert/strict";
import {switchAudioRoute} from "./audio-route.mjs";
test("direct and media routes use complementary gains",()=>{
 const param=()=>({value:1,last:null,
  cancelScheduledValues(t){this.cancel=t;},
  setTargetAtTime(value,time,constant){this.last={value,time,constant};}});
 const player={directRoute:{gain:param()},bridgeRoute:{gain:param()}};
 const ctx={currentTime:20};
 switchAudioRoute(player,ctx,true);
 assert.equal(player.directRoute.gain.last.value,0);
 assert.equal(player.bridgeRoute.gain.last.value,1);
 assert.equal(player.outputRoute,"media");
 switchAudioRoute(player,ctx,false);
 assert.equal(player.directRoute.gain.last.value,1);
 assert.equal(player.bridgeRoute.gain.last.value,.0001);
 assert.equal(player.outputRoute,"direct");
});
