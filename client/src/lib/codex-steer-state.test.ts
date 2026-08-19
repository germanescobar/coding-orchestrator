import test from "node:test";
import assert from "node:assert/strict";
import { shouldEnqueueCodexSteer } from "./codex-steer-state.js";

test("polled Codex turns still attempt native steering", () => {
  assert.equal(shouldEnqueueCodexSteer("unknown"), false);
  assert.equal(shouldEnqueueCodexSteer("active"), false);
});

test("observed terminal Codex turns enqueue instead of steering", () => {
  assert.equal(shouldEnqueueCodexSteer("terminal"), true);
});
