import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import http from "node:http";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/*
 * Issue #332: the DELETE /projects/:id/worktrees/:wt route used to call
 * `git worktree remove --force` and then `fs.rm --recursive` after
 * checking only for an *active runtime session*. A paused worktree
 * with uncommitted changes would be silently destroyed. This test
 * covers the new gate: dirty worktrees require `?force=1`, and force
 * deletes still refuse to wipe uncommitted changes when no archive
 * script is configured to recover them.
 */

interface Env {
  homeDir: string;
  baseUrl: string;
  projectId: string;
  worktreeId: string;
  projectPath: string;
  worktreePath: string;
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

async function buildRepo(projectPath: string): Promise<void> {
  await runGit(projectPath, ["init", "--initial-branch=main"]);
  await runGit(projectPath, ["config", "user.email", "test@example.com"]);
  await runGit(projectPath, ["config", "user.name", "Test"]);
  await runGit(projectPath, ["config", "commit.gpgsign", "false"]);
  await fs.writeFile(path.join(projectPath, "README.md"), "v1\n");
  await runGit(projectPath, ["add", "README.md"]);
  await runGit(projectPath, ["commit", "-m", "v1"]);
}

async function withDeleteEnv<T>(
  setup: (ctx: Env) => Promise<void>,
  fn: (ctx: Env) => Promise<T>
): Promise<T> {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "wt-delete-test-"));
  const previous = process.env.CONTROLLER_HOME;
  process.env.CONTROLLER_HOME = homeDir;

  const projectId = "proj-1";
  const worktreeId = "wt-1";
  const projectPath = path.join(homeDir, "source");
  const worktreePath = path.join(projectPath, "wt", "issue-1");
  await fs.mkdir(projectPath, { recursive: true });
  await buildRepo(projectPath);
  await runGit(projectPath, ["worktree", "add", "-b", "issue-1", worktreePath]);

  await fs.writeFile(
    path.join(homeDir, "projects.json"),
    JSON.stringify([
      {
        id: projectId,
        name: "demo",
        path: projectPath,
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ])
  );
  await fs.writeFile(
    path.join(homeDir, "worktrees.json"),
    JSON.stringify([
      {
        id: worktreeId,
        projectId,
        name: "issue-1",
        path: worktreePath,
        branch: "issue-1",
        isMain: false,
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ])
  );

  await setup({ homeDir, baseUrl: "", projectId, worktreeId, projectPath, worktreePath });

  const { worktreesRouter } = await import("../../routes/worktrees.js");
  const app = express();
  app.use(express.json());
  app.use("/api/projects", worktreesRouter);
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const baseUrl = `http://127.0.0.1:${port}/api/projects/${projectId}/worktrees/${worktreeId}`;

  try {
    return await fn({ homeDir, baseUrl, projectId, worktreeId, projectPath, worktreePath });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (previous === undefined) delete process.env.CONTROLLER_HOME;
    else process.env.CONTROLLER_HOME = previous;
    await fs.rm(homeDir, { recursive: true, force: true });
  }
}

test("DELETE refuses a dirty worktree with 409 (default-on safety)", async () => {
  await withDeleteEnv(async ({ worktreePath }) => {
    // Drop a tracked modification in the worktree so `git status`
    // reports it as dirty.
    await fs.writeFile(path.join(worktreePath, "README.md"), "v1-edited\n");
  }, async ({ baseUrl, projectPath, worktreePath }) => {
    const res = await fetch(baseUrl, { method: "DELETE" });
    assert.equal(res.status, 409);
    const body = (await res.json()) as { error: string; dirtyFiles: string[] };
    assert.match(body.error, /uncommitted changes/);
    assert.ok(body.dirtyFiles.length > 0);

    // The directory must still exist on disk — refusing is the whole
    // point of the gate.
    const stat = await fs.stat(worktreePath);
    assert.ok(stat.isDirectory());

    // And the worktree must still be registered in the orchestrator.
    const list = await fetch(`http://127.0.0.1:${new URL(baseUrl).port}/api/projects/proj-1/worktrees`);
    const rows = (await list.json()) as Array<{ id: string }>;
    assert.ok(rows.some((row) => row.id === "wt-1"));
    // Project root should also still be a git worktree of itself.
    await runGit(projectPath, ["worktree", "list"]);
  });
});

test("DELETE allows a clean worktree to be deleted", async () => {
  await withDeleteEnv(async () => {
    // No edits — the worktree is clean.
  }, async ({ baseUrl, worktreePath }) => {
    const res = await fetch(baseUrl, { method: "DELETE" });
    assert.equal(res.status, 200);
    // Directory should be gone (git worktree remove or fs.rm fallback).
    await assert.rejects(fs.stat(worktreePath), (err: unknown) => {
      assert.equal((err as NodeJS.ErrnoException).code, "ENOENT");
      return true;
    });
  });
});

test("DELETE with ?force=1 deletes a dirty worktree (archive runs first)", async () => {
  await withDeleteEnv(async ({ homeDir, projectPath, worktreePath }) => {
    // Make the worktree dirty.
    await fs.writeFile(path.join(worktreePath, "README.md"), "v1-edited\n");

    // Install an archive.sh that captures the dirty file by copying
    // it to a known sibling directory. This is the orchestrator's
    // recovery path for destructive deletions.
    const recoveryDir = path.join(homeDir, "recovery");
    await fs.mkdir(recoveryDir, { recursive: true });
    await fs.mkdir(path.join(projectPath, ".coding-orchestrator"), { recursive: true });
    const archiveScript = path.join(projectPath, ".coding-orchestrator", "archive.sh");
    await fs.writeFile(
      archiveScript,
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        // WORKTREE_PATH is provided by `buildScriptEnv`. The
        // orchestrator doesn't expose HOME to project scripts (it
        // uses its own home), so we copy into the parent of
        // WORKTREE_PATH, which is the project root.
        `cp "${worktreePath}/README.md" "${recoveryDir}/archived-readme.md"`,
        "echo archived",
        "",
      ].join("\n"),
      { mode: 0o755 }
    );
  }, async ({ baseUrl, homeDir, worktreePath }) => {
    const res = await fetch(`${baseUrl}?force=1`, { method: "DELETE" });
    assert.equal(res.status, 200);

    // The archive script must have captured the dirty README before
    // the directory was destroyed.
    const archived = await fs.readFile(
      path.join(homeDir, "recovery", "archived-readme.md"),
      "utf-8"
    );
    assert.match(archived, /v1-edited/);

    // Worktree directory is gone.
    await assert.rejects(fs.stat(worktreePath));
  });
});

test("DELETE with ?force=1 refuses when the worktree is dirty but no archive.sh is configured", async () => {
  await withDeleteEnv(async ({ worktreePath }) => {
    await fs.writeFile(path.join(worktreePath, "README.md"), "v1-edited\n");
  }, async ({ baseUrl, worktreePath }) => {
    const res = await fetch(`${baseUrl}?force=1`, { method: "DELETE" });
    assert.equal(res.status, 409);
    const body = (await res.json()) as { error: string };
    assert.match(body.error, /archive script/);

    // Directory survives — the gate refuses the destructive removal.
    const stat = await fs.stat(worktreePath);
    assert.ok(stat.isDirectory());
  });
});