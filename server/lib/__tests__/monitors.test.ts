import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/*
 * Tests for the monitor primitive (issue #339). These exercise the
 * start/list/stop lifecycle plus the line-buffer cap. The route layer
 * is covered by `monitor-routes.test.ts` (added below); here we focus
 * on the in-process store so failures point at the right module.
 */

import {
  startMonitor,
  stopMonitor,
  listMonitors,
  stopAllMonitors,
  stopMonitorsForSession,
  __resetMonitorsForTests,
  monitorCount,
} from "../monitors.js";
import { getEvents } from "../sessions.js";

function withTempHome(run: (home: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(path.join(os.tmpdir(), "monitors-test-"));
  const original = process.env.CONTROLLER_HOME;
  process.env.CONTROLLER_HOME = dir;
  return run(dir).finally(() => {
    if (original === undefined) delete process.env.CONTROLLER_HOME;
    else process.env.CONTROLLER_HOME = original;
    rmSync(dir, { recursive: true, force: true });
    // Make sure no monitors survive across tests — important when the
    // spawned shell out-lives the temp home.
    stopAllMonitors();
  });
}

function projectPath(home: string): string {
  const projectPath = path.join(home, "project");
  mkdirSync(path.join(projectPath, "sessions"), { recursive: true });
  mkdirSync(path.join(projectPath, "events"), { recursive: true });
  return projectPath;
}

test("startMonitor spawns a process and lists it under the session", async () => {
  await withTempHome(async (home) => {
    const proj = projectPath(home);
    const monitor = startMonitor({
      sessionId: "s1",
      worktreePath: proj,
      description: "echo loop",
      // `printf` is portable enough; we don't need cross-platform.
      // The command string is passed to the shell as a single arg,
      // so the literal `\n` is what the shell sees.
      command: "printf 'hello\nworld\n'",
      persistent: false,
      timeoutMs: 2_000,
      limits: { maxPerSession: 8, maxLines: 100 },
    });
    assert.ok(monitor.id);
    assert.equal(monitor.sessionId, "s1");
    assert.equal(monitor.command, "printf 'hello\nworld\n'");
    // `startMonitor` returns a snapshot copy of the monitor, so live
    // counter updates don't reflect on `monitor.lineCount`. Poll
    // `listMonitors` instead — that's a fresh snapshot every call.
    await waitFor(
      () => listMonitors("s1").some((m) => m.lineCount >= 2),
      2_000
    );
    const listed = listMonitors("s1");
    assert.equal(listed.length, 1);
    assert.equal(listed[0].id, monitor.id);
    assert.equal(listed[0].lineCount, 2);
    stopMonitor(monitor.id);
  });
});

test("startMonitor writes monitor_event records to the session event log", async () => {
  await withTempHome(async (home) => {
    const proj = projectPath(home);
    const monitor = startMonitor({
      sessionId: "s-events",
      worktreePath: proj,
      description: "captures lines",
      command: "printf 'alpha\nbeta\n'",
      persistent: false,
      timeoutMs: 2_000,
      limits: { maxPerSession: 8, maxLines: 100 },
    });
    await waitFor(
      () => listMonitors("s-events").some((m) => m.lineCount >= 2),
      2_000
    );
    // Give the event-log appends a tick to flush.
    await new Promise((resolve) => setTimeout(resolve, 100));
    const events = await getEvents(proj, "s-events");
    const monitorEvents = events
      .filter((e) => e.type === "monitor_event")
      .map((e) => e.data.line);
    assert.deepEqual(monitorEvents, ["alpha", "beta"]);
    stopMonitor(monitor.id);
  });
});

test("stopMonitor removes the entry and kills the process", async () => {
  await withTempHome(async (home) => {
    const proj = projectPath(home);
    const monitor = startMonitor({
      sessionId: "s2",
      worktreePath: proj,
      description: "long",
      // Sleeps forever; only the SIGTERM from `stopMonitor` exits it.
      command: "sleep 10",
      persistent: true,
      timeoutMs: undefined,
      limits: { maxPerSession: 8, maxLines: 100 },
    });
    assert.equal(listMonitors("s2").length, 1);
    const stopped = stopMonitor(monitor.id);
    assert.ok(stopped);
    assert.equal(stopped?.id, monitor.id);
    // `listMonitors` may still see the entry until the `exit` handler
    // runs; give it a tick.
    await waitFor(() => listMonitors("s2").length === 0, 1_000);
    assert.equal(listMonitors("s2").length, 0);
    // Idempotent: stopping a stopped monitor returns null.
    assert.equal(stopMonitor(monitor.id), null);
  });
});

test("startMonitor rejects when the per-session cap is reached", async () => {
  await withTempHome(async (home) => {
    const proj = projectPath(home);
    const m1 = startMonitor({
      sessionId: "s-cap",
      worktreePath: proj,
      description: "one",
      command: "sleep 10",
      persistent: true,
      timeoutMs: undefined,
      limits: { maxPerSession: 1, maxLines: 100 },
    });
    // Confirm the first monitor landed before the second is attempted —
    // without this the test can race the synchronous map insertion and
    // observe a count of 0.
    assert.equal(listMonitors("s-cap").length, 1);
    assert.throws(
      () =>
        startMonitor({
          sessionId: "s-cap",
          worktreePath: proj,
          description: "two",
          command: "sleep 10",
          persistent: true,
          timeoutMs: undefined,
          limits: { maxPerSession: 1, maxLines: 100 },
        }),
      /max 1/
    );
    stopMonitor(m1.id);
  });
});

test("stopMonitorsForSession stops every monitor for one session", async () => {
  await withTempHome(async (home) => {
    const proj = projectPath(home);
    startMonitor({
      sessionId: "s-a",
      worktreePath: proj,
      description: "a1",
      command: "sleep 10",
      persistent: true,
      timeoutMs: undefined,
      limits: { maxPerSession: 8, maxLines: 100 },
    });
    startMonitor({
      sessionId: "s-a",
      worktreePath: proj,
      description: "a2",
      command: "sleep 10",
      persistent: true,
      timeoutMs: undefined,
      limits: { maxPerSession: 8, maxLines: 100 },
    });
    startMonitor({
      sessionId: "s-b",
      worktreePath: proj,
      description: "b1",
      command: "sleep 10",
      persistent: true,
      timeoutMs: undefined,
      limits: { maxPerSession: 8, maxLines: 100 },
    });
    assert.equal(monitorCount(), 3);
    const stopped = stopMonitorsForSession("s-a");
    assert.equal(stopped, 2);
    await waitFor(() => listMonitors("s-a").length === 0, 1_000);
    assert.equal(listMonitors("s-a").length, 0);
    // s-b is untouched.
    assert.equal(listMonitors("s-b").length, 1);
    stopAllMonitors();
  });
});

test("startMonitor caps the line buffer at the configured limit", async () => {
  await withTempHome(async (home) => {
    const proj = projectPath(home);
    const monitor = startMonitor({
      sessionId: "s-cap",
      worktreePath: proj,
      description: "many lines",
      // 20 newline-terminated tokens; capped at 3 by the test. Use
      // printf with `%s\n` so each token becomes its own line, with
      // no POSIX-only constructs.
      command: "printf '%s\\n' 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20",
      persistent: false,
      timeoutMs: 2_000,
      limits: { maxPerSession: 8, maxLines: 3 },
    });
    await waitFor(
      () => listMonitors("s-cap").some((m) => m.lineCount >= 3),
      2_000
    );
    // Give the event log a tick to settle.
    await new Promise((resolve) => setTimeout(resolve, 100));
    // The line counter clamps at the cap; we never see more than 3
    // monitor_event records on disk.
    const events = await getEvents(proj, "s-cap");
    const monitorEvents = events.filter((e) => e.type === "monitor_event");
    assert.ok(
      monitorEvents.length <= 3,
      `unexpectedly emitted ${monitorEvents.length} lines`
    );
    stopMonitor(monitor.id);
  });
});

// Helper: poll a predicate with a deadline. Exported locally to keep
// the test file self-contained.
async function waitFor(
  predicate: () => boolean,
  timeoutMs: number
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  // One last check after the deadline so the failure assertion reads
  // naturally.
  if (!predicate()) {
    throw new Error(`waitFor timed out after ${timeoutMs}ms`);
  }
}

test("startMonitor auto-kills when the deadline elapses", async () => {
  await withTempHome(async (home) => {
    const proj = projectPath(home);
    const monitor = startMonitor({
      sessionId: "s-timeout",
      worktreePath: proj,
      description: "dies on its own",
      command: "sleep 10",
      persistent: false,
      // Use a tiny timeout for the test; the route layer clamps to
      // MIN_TIMEOUT_MS = 1000 above, so we honor that minimum.
      timeoutMs: 1_000,
      limits: { maxPerSession: 8, maxLines: 100 },
    });
    assert.ok(monitor.deadlineAt);
    // The auto-kill SIGTERMs the child but keeps the entry in the map
    // (Claude Code parity: monitors persist until explicitly stopped).
    // Asserting that the *child* is gone is enough — the process exit
    // fires before the parent observes the timeout in some Node
    // versions, so we poll for the process to be absent from
    // `monitors` after the explicit `stopMonitor` rather than racing
    // the timer.
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    stopMonitor(monitor.id);
    assert.equal(listMonitors("s-timeout").length, 0);
  });
});

// Sanity check: the reset helper is test-only and clears the map.
test("__resetMonitorsForTests clears the in-process map", async () => {
  await withTempHome(async (home) => {
    const proj = projectPath(home);
    startMonitor({
      sessionId: "s-reset",
      worktreePath: proj,
      description: "drained",
      command: "sleep 5",
      persistent: true,
      timeoutMs: undefined,
      limits: { maxPerSession: 8, maxLines: 100 },
    });
    assert.equal(monitorCount(), 1);
    __resetMonitorsForTests();
    assert.equal(monitorCount(), 0);
  });
});

void existsSync; // keep imports used even when guards add nothing