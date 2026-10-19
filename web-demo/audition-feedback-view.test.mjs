import {test} from "node:test";
import assert from "node:assert/strict";
import {createPlaybackFeedback} from "./playback-feedback.mjs";
import {auditionFeedbackView} from "./audition-feedback-view.mjs";

test("theoretical graph and stopped/original transport never claim processed audio",()=>{
  assert.deepEqual(auditionFeedbackView(),{
    phase:"idle",text:"音源未選択 · グラフは理論値"
  });
  const stopped=auditionFeedbackView({loaded:true});
  assert.equal(stopped.phase,"stopped");
  assert.match(stopped.text,/理論値/);
  for(const player of [{directDry:true,mode:"dry"},{mode:"dry"}]){
    const view=auditionFeedbackView({loaded:true,player});
    assert.equal(view.phase,"dry");
    assert.match(view.text,/原音のみ/);
  }
  assert.equal(auditionFeedbackView({loaded:true,
    player:{mode:"wet",feedback:createPlaybackFeedback()},wetMix:0}).phase,"dry");
});
test("ACK is separate from request, late ACK and real audio measurement",()=>{
  const f=createPlaybackFeedback();f.ready();
  const player={mode:"wet",feedback:f};
  assert.equal(auditionFeedbackView({loaded:true,player}).phase,"ready");
  f.request(1);assert.equal(auditionFeedbackView({loaded:true,player}).phase,"pending");
  assert.equal(f.ack(1),true);
  const ack=auditionFeedbackView({loaded:true,player});
  assert.equal(ack.phase,"applied");assert.match(ack.text,/実音の測定ではありません/);
  f.request(2);
  assert.equal(f.ack(1),false);
  assert.equal(auditionFeedbackView({loaded:true,player}).phase,"pending");
  f.reject("Unsupported physical range");
  assert.equal(auditionFeedbackView({loaded:true,player}).phase,"rejected");
  assert.equal(f.ack(2),false);
  assert.equal(auditionFeedbackView({loaded:true,player}).phase,"rejected");
  f.request(3);f.rebuild();
  assert.equal(auditionFeedbackView({loaded:true,player}).phase,"rebuilding");
  f.request(4);f.fail(4,"Processor error");
  assert.equal(auditionFeedbackView({loaded:true,player}).phase,"failed");
  f.request(5);f.ack(5);
  assert.equal(auditionFeedbackView({loaded:true,player}).phase,"applied");
});
