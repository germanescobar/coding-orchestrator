import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/*
 * Integration test for the archive path's monitor cleanup (issue #339
 * review). The route layer is what actually wires `archiveSession` +
 * `stopMonitorsForSession` together; the unit-level test for the
 * in-process monitors store lives in `monitors.test.ts`.
 *
 * Without this hook a persistent monitor started against an
 * already-archived session would keep running its shell command and
 * appending events to the (now-archived) session's event log.
 */

interface ArchiveEnv {
  baseUrl: string;
  projectId: string;
  worktreeId: string;
  sessionId: string;
  cleanup: () => Promise<void>;
}

async function withArchiveRoutes(
  fn: (env: ArchiveEnv) => Promise<void>
): Promise<void> {
  const homeDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "archive-monitor-cleanup-")
  );
  const previous = process.env.CONTROLLER_HOME;
  process.env.CONTROLLER_HOME = homeDir;
  const projectId = "proj-1";
  const worktreeId = "wt-1";
  const sessionId = "s-1";
  const projectPath = path.join(homeDir, "source");
  const wtPath = path.join(homeDir, "feature");
  await fs.mkdir(path.join(projectPath, "sessions"), { recursive: true });
  await fs.mkdir(path.join(projectPath, "events"), { recursive: true });
  // Plant the session file under the *Controller-owned* session
  // store (issue #339 review: per-worktree store, keyed off the
  // worktree path's SHA-256 via `projectStoreDir`).
  const { projectStoreDir } = await import("../paths.js");
  const wtSessionDir = projectStoreDir(wtPath);
  await fs.mkdir(path.join(wtSessionDir, "sessions"), { recursive: true });
  await fs.writeFile(
    path.join(homeDir, "projects.json"),
    JSON.stringify([
      {
        id: projectId,
        name: "demo",
        path: projectPath,
        createdAt: new Date().toISOString(),
      },
    ])
  );
  // Plant the session file the archive path will rewrite.
  await fs.writeFile(
    path.join(wtSessionDir, "sessions", `${sessionId}.json`),
    JSON.stringify({
      id: sessionId,
      workingDirectory: wtPath,
      provider: "claude",
      model: "claude/test",
      status: "active",
    })
  );
  // Plant the worktree registry so `resolveWorktree` finds a path.
  await fs.writeFile(
    path.join(homeDir, "worktrees.json"),
    JSON.stringify([
      {
        id: worktreeId,
        projectId,
        name: "feature",
        path: wtPath,
        branch: "feature",
        isMain: true,
        createdAt: new Date().toISOString(),
      },
    ])
  );
  const { sessionsRouter } = await import("../../routes/sessions.js");
  const app = express();
  app.use(express.json({ limit: "10mb" }));
  app.use("/api/projects", sessionsRouter);
  const server = http.createServer(app);
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve())
  );
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("server failed to bind a port");
  }
  const baseUrl = `http://127.0.0.1:${address.port}/api/projects`;
  const cleanup = async () => {
    // The monitor's child process might still be alive briefly
    // after the test; drain it through the public API.
    const { stopAllMonitors } = await import("../monitors.js");
    stopAllMonitors();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (previous === undefined) delete process.env.CONTROLLER_HOME;
    else process.env.CONTROLLER_HOME = previous;
    await fs.rm(homeDir, { recursive: true, force: true });
  };
  try {
    await fn({ baseUrl, projectId, worktreeId, sessionId, cleanup });
  } finally {
    await cleanup();
  }
}

test("archiveSession route stops persistent monitors for the session", async () => {
  await withArchiveRoutes(async ({ baseUrl, projectId, sessionId }) => {
    const { startMonitor, listMonitors } = await import("../monitors.js");
    // Start a persistent monitor (no timeout → no auto-kill). The
    // archive path must explicitly stop it.
    const wtPath = path.join(
      process.env.CONTROLLER_HOME ?? ".",
      "feature"
    );
    startMonitor({
      sessionId,
      worktreePath: wtPath,
      description: "persistent watcher",
      command: "sleep 30",
      persistent: true,
      // Bypasses the 1s MIN_TIMEOUT_MS clamp by going persistent.
      timeoutMs: undefined,
      limits: { maxPerSession: 8, maxLines: 100 },
    });
    assert.equal(listMonitors(sessionId).length, 1);

    const response = await fetch(
      `${baseUrl}/${projectId}/sessions/${sessionId}/archive?worktreeId=${"wt-1"}`,
      { method: "POST" }
    );
    if (response.status !== 200) {
      const body = await response.text();
      assert.fail(
        `archive returned ${response.status}: ${body}\n` +
          `projectId=${projectId}\n` +
          `baseUrl=${baseUrl}\n`
      );
    }
    // The monitor should be gone from the in-process map after
    // archive. Persistent monitors that were killed via SIGTERM
    // also drop out of the map; the consumer of this test only
    // cares that `listMonitors` is empty.
    assert.equal(listMonitors(sessionId).length, 0);
  });
});

void path;