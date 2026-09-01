import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/*
 * Goal sidecar CRUD tests (issue #339). The shape mirrors the focus
 * sidecar (`server/lib/focus-state.test.ts`) — same per-session id
 * directory, separate Controller-owned files. The two never share a
 * path on disk so a malformed goal must never break focus reads and
 * vice versa.
 */

import {
  buildSessionGoal,
  clearSessionGoal,
  readSessionGoal,
  writeSessionGoal,
  type SessionGoal,
} from "../goal-state.js";

function withTempHome(run: () => Promise<void>): Promise<void> {
  const dir = mkdtempSync(path.join(os.tmpdir(), "goal-state-test-"));
  const original = process.env.CONTROLLER_HOME;
  process.env.CONTROLLER_HOME = dir;
  return run().finally(() => {
    if (original === undefined) delete process.env.CONTROLLER_HOME;
    else process.env.CONTROLLER_HOME = original;
    rmSync(dir, { recursive: true, force: true });
  });
}

test("readSessionGoal returns null when no sidecar exists", async () => {
  await withTempHome(async () => {
    assert.equal(await readSessionGoal("s1"), null);
  });
});

test("buildSessionGoal stamps sessionId, setAt, and updatedAt", async () => {
  await withTempHome(async () => {
    const goal = buildSessionGoal("s1", {
      condition: "all CI checks pass",
      maxTurns: 5,
    });
    assert.equal(goal.sessionId, "s1");
    assert.equal(goal.condition, "all CI checks pass");
    assert.equal(goal.maxTurns, 5);
    assert.equal(goal.turnsEvaluated, 0);
    assert.ok(goal.setAt);
    assert.ok(goal.updatedAt);
    assert.equal(goal.setAt, goal.updatedAt);
  });
});

test("buildSessionGoal rejects an empty condition", async () => {
  await withTempHome(async () => {
    assert.throws(
      () => buildSessionGoal("s1", { condition: "  " }),
      /condition must not be empty/
    );
  });
});

test("buildSessionGoal rejects non-positive maxTurns", async () => {
  await withTempHome(async () => {
    assert.throws(
      () => buildSessionGoal("s1", { condition: "x", maxTurns: 0 }),
      /maxTurns must be a positive integer/
    );
    assert.throws(
      () => buildSessionGoal("s1", { condition: "x", maxTurns: 1.5 }),
      /maxTurns must be a positive integer/
    );
  });
});

test("buildSessionGoal rejects malformed expiresAt", async () => {
  await withTempHome(async () => {
    assert.throws(
      () => buildSessionGoal("s1", { condition: "x", expiresAt: "not-a-date" }),
      /Invalid goal expiresAt/
    );
  });
});

test("writeSessionGoal persists and reads back identically", async () => {
  await withTempHome(async () => {
    const goal = buildSessionGoal("s1", { condition: "green CI" });
    await writeSessionGoal(goal);
    const reloaded = await readSessionGoal("s1");
    assert.ok(reloaded);
    // JSON round-trip drops `undefined` keys; compare via the same shape.
    assert.deepEqual(reloaded, JSON.parse(JSON.stringify(goal)));
  });
});

test("writeSessionGoal replaces an existing sidecar on update", async () => {
  await withTempHome(async () => {
    const first = buildSessionGoal("s1", { condition: "first" });
    await writeSessionGoal(first);
    const second: SessionGoal = {
      ...first,
      condition: "second",
      turnsEvaluated: 3,
    };
    await writeSessionGoal(second);
    const reloaded = await readSessionGoal("s1");
    assert.equal(reloaded?.condition, "second");
    assert.equal(reloaded?.turnsEvaluated, 3);
  });
});

test("clearSessionGoal removes the sidecar entirely", async () => {
  await withTempHome(async () => {
    const goal = buildSessionGoal("s1", { condition: "x" });
    await writeSessionGoal(goal);
    assert.ok(await readSessionGoal("s1"));
    await clearSessionGoal("s1");
    assert.equal(await readSessionGoal("s1"), null);
    // Idempotent: clearing a missing goal is a no-op.
    await clearSessionGoal("s1");
    assert.equal(await readSessionGoal("s1"), null);
  });
});

test("readSessionGoal ignores a focus sidecar (shape discriminator)", async () => {
  // Goal sidecars live in a separate directory from focus, but if a
  // future migration ever puts them in the same place the shape
  // discriminator (`condition` + `setAt`) must reject focus files so
  // a malformed goal never masquerades as a real one.
  await withTempHome(async () => {
    const { sessionFocusFile, sessionFocusDir } = await import("../paths.js");
    const fs = await import("node:fs/promises");
    await fs.mkdir(sessionFocusDir(), { recursive: true });
    await fs.writeFile(
      sessionFocusFile("s1"),
      JSON.stringify({
        sessionId: "s1",
        focusPinnedAt: "2026-06-26T08:00:00.000Z",
        updatedAt: "2026-06-26T08:00:00.000Z",
      })
    );
    // The goal sidecar is in a different directory, so reading returns
    // null. The discriminator would catch a malformed goal too.
    assert.equal(await readSessionGoal("s1"), null);
  });
});

test("writeSessionGoal with null clears (separate sessionId parameter)", async () => {
  await withTempHome(async () => {
    await writeSessionGoal(
      buildSessionGoal("s1", { condition: "x" }),
      "s1"
    );
    await writeSessionGoal(null, "s1");
    assert.equal(await readSessionGoal("s1"), null);
  });
});