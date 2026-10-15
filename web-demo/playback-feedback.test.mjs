import {test} from "node:test";
import assert from "node:assert/strict";
import {createPlaybackFeedback} from "./playback-feedback.mjs";

test("older ACK never marks a newer revision applied",()=>{
  const f=createPlaybackFeedback();f.ready();
  f.request(10);f.request(11);
  assert.equal(f.ack(10),false);
  assert.deepEqual([f.current.phase,f.current.requestedRevision,f.current.appliedRevision],
    ["pending",11,10]);
  assert.equal(f.ack(11),true);
  assert.equal(f.current.phase,"applied");
  assert.equal(f.current.appliedRevision,11);
});
test("stale error cannot overwrite latest pending or applied state",()=>{
  const f=createPlaybackFeedback();f.ready();
  f.request(1);f.request(2);
  assert.equal(f.fail(1,"old failure"),false);
  assert.equal(f.current.phase,"pending");
  assert.equal(f.ack(2),true);
  assert.equal(f.fail(1,"late failure"),false);
  assert.equal(f.current.phase,"applied");
});
test("latest rejected input survives ACK of previous in-flight edit",()=>{
  const f=createPlaybackFeedback();f.ready();
  f.request(1);f.reject("20,000Hz limit");
  assert.equal(f.ack(1),false);
  assert.equal(f.current.phase,"rejected");
  assert.equal(f.current.appliedRevision,1);
  assert.match(f.current.reason,/20,000Hz/);
  f.request(2);assert.equal(f.ack(2),true);
  assert.equal(f.current.phase,"applied");
});
test("latest failure persists until a later acknowledged recovery",()=>{
  const f=createPlaybackFeedback();f.ready();
  f.request(5);assert.equal(f.fail(5,"Rust error"),true);
  assert.equal(f.ack(5),false);
  assert.equal(f.current.phase,"failed");
  f.request(6);assert.equal(f.ack(6),true);
  assert.equal(f.current.phase,"applied");
});
test("queued old acknowledgements do not clear rebuild pending",()=>{
  const f=createPlaybackFeedback();f.ready();
  f.request(3);f.rebuild();
  assert.equal(f.ack(3),false);
  assert.equal(f.current.phase,"rebuilding");
});
test("no ACK from the future or revision zero is accepted",()=>{
  const f=createPlaybackFeedback();f.ready();
  f.request(3);
  assert.equal(f.ack(4),false);assert.equal(f.ack(0),false);
  assert.equal(f.current.phase,"pending");
  assert.throws(()=>f.request(3),/increase monotonically/);
});
test("unversioned audio processing failures remain visible",()=>{
  const f=createPlaybackFeedback();f.ready();
  assert.equal(f.fail(undefined,"Streaming core returned 3"),true);
  assert.equal(f.current.phase,"failed");
  assert.match(f.current.reason,/Streaming core/);
});
