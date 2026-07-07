import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import http from "node:http";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/*
 * Issue #296: when the user closes a terminal tab, the underlying tmux
 * session must be killed on the server, independent of the WebSocket
 * lifecycle. Otherwise the periodic `getTerminalTabs` poll re-discovers
 * the still-alive tmux session and re-adds it as a fresh tab.
 *
 * This test exercises `PUT /api/projects/:projectId/terminal-tabs` with a
 * `removeTerminalId` and asserts that the tmux session backing that
 * terminal is gone after the call. The WebSocket path is intentionally
 * not used — the bug is that the close is *only* delivered over the WS,
 * so the test models the worst case (the WS never opened, or was
 * disconnected before the close arrived) and confirms the HTTP path
 * still kills the tmux session.
 */

function tmuxAvailable(): boolean {
  try {
    execFileSync("tmux", ["-V"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function runGit(cwd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    let stderr = "";
    child.stderr?.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("close", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`git ${args.join(" ")} failed: ${stderr}`))
    );
    child.on("error", reject);
  });
}

function listTmuxSessions(): string[] {
  try {
    const output = execFileSync("tmux", ["list-sessions", "-F", "#{session_name}"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return output
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

interface RemoveEnv {
  baseUrl: string;
  projectId: string;
  worktreeId: string;
  worktreePath: string;
}

async function withRoutes<T>(fn: (env: RemoveEnv) => Promise<T>): Promise<T> {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "terminal-tabs-remove-"));
  const previous = process.env.CONTROLLER_HOME;
  process.env.CONTROLLER_HOME = homeDir;

  const projectId = "proj-1";
  const projectPath = path.join(homeDir, "source");
  await fs.mkdir(projectPath, { recursive: true });
  await runGit(projectPath, ["init", "--initial-branch=main"]);
  await runGit(projectPath, ["config", "user.email", "test@example.com"]);
  await runGit(projectPath, ["config", "user.name", "Test"]);
  await fs.writeFile(path.join(projectPath, "README.md"), "v1\n");
  await runGit(projectPath, ["add", "README.md"]);
  await runGit(projectPath, ["commit", "-m", "v1"]);
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

  const { worktreesRouter } = await import("../../routes/worktrees.js");
  const app = express();
  app.use(express.json({ limit: "10mb" }));
  app.use("/api/projects", worktreesRouter);
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const baseUrl = `http://127.0.0.1:${port}/api/projects`;

  try {
    const { getProjectWorktrees } = await import("../../lib/worktrees.js");
    const worktrees = await getProjectWorktrees(projectId);
    const main = worktrees.find((w) => w.isMain);
    if (!main) throw new Error("main worktree not found");
    return await fn({
      baseUrl,
      projectId,
      worktreeId: main.id,
      worktreePath: main.path,
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (previous === undefined) delete process.env.CONTROLLER_HOME;
    else process.env.CONTROLLER_HOME = previous;
    await fs.rm(homeDir, { recursive: true, force: true });
  }
}

function putTabs(
  baseUrl: string,
  projectId: string,
  worktreeId: string,
  body: Record<string, unknown>
): Promise<Response> {
  return fetch(`${baseUrl}/${projectId}/terminal-tabs?worktreeId=${worktreeId}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("PUT /terminal-tabs with removeTerminalId kills the underlying tmux session", async (t) => {
  if (!tmuxAvailable()) {
    t.skip("tmux is not available");
    return;
  }

  await withRoutes(async ({ baseUrl, projectId, worktreeId, worktreePath }) => {
    const { ptyManager, tmuxSessionNames } = await import("../../lib/pty-manager.js");
    const terminalId = "ghost";
    const sessionId = `${projectId}:${worktreeId}:${terminalId}`;
    const expectedNames = tmuxSessionNames(sessionId);

    // Simulate the worst case from the bug: the user clicked X *before*
    // any WebSocket ever opened. PTY exists (because `run-script` or the
    // new-tab flow spawned it), but the WS handshake is still pending —
    // so the WS-based `close` message would never be sent, and the
    // unmount-time plain `ws.close()` would be treated as a disconnect
    // that the server intentionally ignores. With the fix, the HTTP PUT
    // is authoritative.
    const created = ptyManager.getOrCreate(sessionId, worktreePath);
    if (created.error) {
      t.skip(`could not spawn a PTY: ${created.error}`);
      return;
    }

    // Seed a tab entry to model the "open tab" state the user is closing.
    await putTabs(baseUrl, projectId, worktreeId, {
      tabs: [{ id: "default", label: "Terminal 1" }, { id: terminalId, label: "Terminal 2" }],
    });

    // Confirm the tmux session is alive before the close.
    const beforeSessions = listTmuxSessions();
    assert.ok(
      beforeSessions.some((name) => expectedNames.includes(name)),
      `expected tmux session ${expectedNames.join(" or ")} to exist before close, saw: ${beforeSessions.join(", ")}`
    );

    // The fix: PUT with `removeTerminalId` kills the tmux session before
    // `setTerminalTabs` reads the discovery list.
    const res = await putTabs(baseUrl, projectId, worktreeId, {
      tabs: [{ id: "default", label: "Terminal 1" }],
      removeTerminalId: terminalId,
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { tabs: Array<{ id: string }> };
    assert.deepEqual(
      body.tabs.map((t) => t.id),
      ["default"],
      "the closed tab should be removed from the registry"
    );

    // The session is gone from the PTY manager…
    assert.equal(ptyManager.has(sessionId), false, "ptyManager should no longer have the session");
    // …and the tmux session itself is gone too (this is what the periodic
    // poll reads via `listTmuxTerminalIds`).
    const afterSessions = listTmuxSessions();
    assert.ok(
      !afterSessions.some((name) => expectedNames.includes(name)),
      `expected no tmux session ${expectedNames.join(" or ")} to remain, saw: ${afterSessions.join(", ")}`
    );

    // And a subsequent `getTerminalTabs` (the periodic poll that
    // re-merged the zombie) does not re-add the closed tab.
    const getRes = await fetch(
      `${baseUrl}/${projectId}/terminal-tabs?worktreeId=${worktreeId}`
    );
    assert.equal(getRes.status, 200);
    const getBody = (await getRes.json()) as { tabs: Array<{ id: string }> };
    assert.deepEqual(
      getBody.tabs.map((t) => t.id),
      ["default"],
      "the next poll must not re-merge the killed tmux session"
    );
  });
});

test("PUT /terminal-tabs without removeTerminalId leaves existing tmux sessions alone", async (t) => {
  if (!tmuxAvailable()) {
    t.skip("tmux is not available");
    return;
  }

  await withRoutes(async ({ baseUrl, projectId, worktreeId, worktreePath }) => {
    const { ptyManager } = await import("../../lib/pty-manager.js");
    const terminalId = "stayer";
    const sessionId = `${projectId}:${worktreeId}:${terminalId}`;

    const created = ptyManager.getOrCreate(sessionId, worktreePath);
    if (created.error) {
      t.skip(`could not spawn a PTY: ${created.error}`);
      return;
    }

    try {
      // PUT a benign tab list with no `removeTerminalId`. The tmux session
      // must still be there — the kill is scoped to the explicit close.
      const res = await putTabs(baseUrl, projectId, worktreeId, {
        tabs: [
          { id: "default", label: "Terminal 1" },
          { id: terminalId, label: "Terminal 2" },
        ],
      });
      assert.equal(res.status, 200);
      assert.equal(ptyManager.has(sessionId), true);
    } finally {
      ptyManager.kill(sessionId);
    }
  });
});

test("PUT /terminal-tabs with removeTerminalId also kills a legacy coding-orchestrator- tmux session", async (t) => {
  if (!tmuxAvailable()) {
    t.skip("tmux is not available");
    return;
  }

  await withRoutes(async ({ baseUrl, projectId, worktreeId, worktreePath }) => {
    const { ptyManager, tmuxSessionNames } = await import("../../lib/pty-manager.js");
    const terminalId = "legacytab";
    const sessionId = `${projectId}:${worktreeId}:${terminalId}`;

    // Synthesize a legacy-prefix tmux session for this id. A pre-rename
    // build created it under the `coding-orchestrator-` prefix; the
    // periodic `getTerminalTabs` poll still discovers it because
    // `listTmuxTerminalIds` matches both prefixes. The close path must
    // kill it too, otherwise the tab resurfaces on the next poll
    // (review feedback on #296).
    const [, legacyName] = tmuxSessionNames(sessionId);
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        "tmux",
        ["new-session", "-d", "-s", legacyName, "-c", worktreePath, "sleep 60"],
        { env: { ...process.env } }
      );
      let stderr = "";
      child.stderr?.on("data", (d: Buffer) => (stderr += d.toString()));
      child.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`tmux new-session failed (${code}): ${stderr}`));
      });
      child.on("error", reject);
    });

    try {
      // Sanity: the legacy session exists and the current-prefix session
      // does not (we never called `getOrCreate` for this id).
      const before = listTmuxSessions();
      assert.ok(
        before.includes(legacyName),
        `expected legacy tmux session ${legacyName} to exist, saw: ${before.join(", ")}`
      );
      assert.equal(ptyManager.has(sessionId), false);

      // Seed a tab entry (as if the legacy session had been re-discovered
      // and surfaced in the UI) and then close it.
      await putTabs(baseUrl, projectId, worktreeId, {
        tabs: [{ id: "default", label: "Terminal 1" }, { id: terminalId, label: "Terminal 2" }],
      });

      const res = await putTabs(baseUrl, projectId, worktreeId, {
        tabs: [{ id: "default", label: "Terminal 1" }],
        removeTerminalId: terminalId,
      });
      assert.equal(res.status, 200);

      // The legacy session must be gone — otherwise the next poll would
      // re-merge it.
      const after = listTmuxSessions();
      assert.ok(
        !after.includes(legacyName),
        `expected legacy tmux session ${legacyName} to be killed by close, saw: ${after.join(", ")}`
      );

      // And the next poll does not re-add the closed tab.
      const getRes = await fetch(
        `${baseUrl}/${projectId}/terminal-tabs?worktreeId=${worktreeId}`
      );
      assert.equal(getRes.status, 200);
      const getBody = (await getRes.json()) as { tabs: Array<{ id: string }> };
      assert.deepEqual(
        getBody.tabs.map((t) => t.id),
        ["default"],
        "the next poll must not re-merge a legacy tmux session the close killed"
      );
    } finally {
      // Best-effort cleanup in case the assertion failed and the session
      // is still around.
      try {
        execFileSync("tmux", ["kill-session", "-t", `=${legacyName}`], { stdio: "ignore" });
      } catch {
        // Already gone.
      }
    }
  });
});
