import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { createRealtimeRelay } from "./realtimeRelay.js";

function fixture() {
  let connected = true;
  let failOpen = false;
  let opens = 0;
  let changesReceived = 0;
  const streams: Array<EventEmitter & { close: () => void; closed: boolean }> = [];
  const timers: Array<{ callback: () => void; delay: number; cancelled: boolean }> = [];
  const errors: unknown[] = [];
  const relay = createRealtimeRelay({
    isConnected: () => connected,
    open() {
      opens++;
      if (failOpen) throw new Error("MOCK_WATCH_FAILURE");
      const stream = Object.assign(new EventEmitter(), { closed: false, close() { stream.closed = true; stream.emit("close"); } });
      streams.push(stream);
      return stream;
    },
    onChange: () => { changesReceived++; },
    onError: (error) => { errors.push(error); },
    schedule(callback, delay) {
      const timer = { callback, delay, cancelled: false };
      timers.push(timer);
      return () => { timer.cancelled = true; };
    },
  });
  return {
    relay, streams, timers, errors,
    get opens() { return opens; },
    get changesReceived() { return changesReceived; },
    set connected(value: boolean) { connected = value; },
    set failOpen(value: boolean) { failOpen = value; },
    tick() {
      const timer = timers.find((candidate) => !candidate.cancelled);
      assert.ok(timer, "one retry must be scheduled");
      timer.cancelled = true;
      timer.callback();
    },
    get pending() { return timers.filter((timer) => !timer.cancelled).length; },
  };
}

test("relay error closes stream and schedules one restart, ignores obsolete callbacks", () => {
  const f = fixture();
  f.relay.start(); f.relay.start();
  assert.equal(f.opens, 1);
  f.streams[0].emit("error", new Error("MOCK_DROP"));
  f.streams[0].emit("error", new Error("MOCK_DUPLICATE"));
  assert.equal(f.streams[0].closed, true);
  assert.equal(f.pending, 1);
  assert.equal(f.timers[0].delay, 1_000);
  f.tick();
  assert.equal(f.opens, 2);
  f.streams[0].emit("change", {});
  assert.equal(f.changesReceived, 0);
  f.streams[1].emit("change", {});
  assert.equal(f.changesReceived, 1);
  f.relay.stop();
  assert.equal(f.pending, 0);
});

test("watch failures back off 1/2/4/8/16/30 seconds and remain bounded", () => {
  const f = fixture();
  f.failOpen = true;
  f.relay.start();
  for (let attempt = 0; attempt < 7; attempt++) { assert.equal(f.pending, 1); f.tick(); }
  assert.deepEqual(f.timers.map((timer) => timer.delay), [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000]);
  assert.equal(f.errors.length, 8);
  f.relay.stop();
  assert.equal(f.pending, 0);
});

test("disconnected database is retried; external start cancels duplicate retry; close/end recover", () => {
  const f = fixture();
  f.connected = false;
  f.relay.start(); f.tick();
  assert.equal(f.opens, 0);
  f.connected = true;
  f.relay.start();
  assert.equal(f.opens, 1);
  assert.equal(f.pending, 0);
  f.streams[0].emit("close"); f.tick();
  f.streams[1].emit("end"); f.tick();
  assert.equal(f.opens, 3);
  f.streams[2].emit("change", {});
  f.streams[2].emit("error", new Error("MOCK_DROP"));
  assert.equal(f.timers[f.timers.length - 1].delay, 1_000);
  f.relay.stop();
  assert.equal(f.pending, 0);
});
