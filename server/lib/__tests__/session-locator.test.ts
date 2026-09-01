import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/*
 * Tests for the shared session locator (issue #339 review).
 *
 * The original wake / goal / monitor ID-only handlers and the wakes
 * consumer each rolled their own "find which project owns a session"
 * walk, and every one of them stopped at `project.path` — the main
 * worktree — so sessions in non-main worktrees were silently dropped.
 *
 * These tests plant a session in a non-main worktree and assert the
 * shared locator resolves it through the worktree registry.
 */

import { locateSessionById, locateSessionPath } from "../session-locator.js";
import { projectStoreDir } from "../paths.js";

function withTempHome(run: (home: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(path.join(os.tmpdir(), "session-locator-test-"));
  const original = process.env.CONTROLLER_HOME;
  process.env.CONTROLLER_HOME = dir;
  return run(dir).finally(() => {
    if (original === undefined) delete process.env.CONTROLLER_HOME;
    else process.env.CONTROLLER_HOME = original;
    rmSync(dir, { recursive: true, force: true });
  });
}

async function plantProject(
  home: string,
  projectId: string,
  projectName: string,
  projectPath: string
): Promise<void> {
  await writeFileProjectRegistry(home, [
    {
      id: projectId,
      name: projectName,
      path: projectPath,
      createdAt: new Date().toISOString(),
    },
  ]);
}

async function writeFileProjectRegistry(
  home: string,
  projects: Array<{ id: string; name: string; path: string; createdAt: string }>
): Promise<void> {
  const fs = await import("node:fs/promises");
  await fs.writeFile(
    path.join(home, "projects.json"),
    JSON.stringify(projects)
  );
}

test("locateSessionById returns null when no project is registered", async () => {
  await withTempHome(async () => {
    assert.equal(await locateSessionById("missing"), null);
  });
});

test("locateSessionById finds a session in the main worktree", async () => {
  await withTempHome(async (home) => {
    const mainPath = path.join(home, "main");
    mkdirSync(path.join(projectStoreDir(mainPath), "sessions"), { recursive: true });
    writeFileSync(
      path.join(projectStoreDir(mainPath), "sessions", "s1.json"),
      JSON.stringify({ id: "s1", workingDirectory: mainPath })
    );
    await plantProject(home, "proj-1", "demo", mainPath);
    const located = await locateSessionById("s1");
    assert.ok(located);
    assert.equal(located?.projectId, "proj-1");
    assert.equal(located?.worktreePath, mainPath);
  });
});

test("locateSessionById finds a session in a non-main worktree", async () => {
  // The original handlers stopped at `project.path` (main worktree),
  // so a session in a feature branch's worktree was silently dropped.
  // The shared locator enumerates `getProjectWorktrees` to fix this.
  await withTempHome(async (home) => {
    const mainPath = path.join(home, "main");
    const featurePath = path.join(home, "feature");
    mkdirSync(featurePath, { recursive: true });
    mkdirSync(path.join(projectStoreDir(featurePath), "sessions"), { recursive: true });
    writeFileSync(
      path.join(projectStoreDir(featurePath), "sessions", "s1.json"),
      JSON.stringify({
        id: "s1",
        workingDirectory: featurePath,
        worktreeId: "wt-feature",
      })
    );
    await plantProject(home, "proj-1", "demo", mainPath);
    // Plant the worktree registry so `getProjectWorktrees` returns
    // the feature worktree.
    const fs = await import("node:fs/promises");
    await fs.writeFile(
      path.join(home, "worktrees.json"),
      JSON.stringify([
        {
          id: "wt-feature",
          projectId: "proj-1",
          name: "feature",
          path: featurePath,
          branch: "feature",
          isMain: false,
          createdAt: new Date().toISOString(),
        },
      ])
    );
    const located = await locateSessionById("s1");
    assert.ok(located, "locator must walk non-main worktrees");
    assert.equal(located?.projectId, "proj-1");
    assert.equal(located?.worktreePath, featurePath);
    assert.equal(located?.worktreeId, "wt-feature");
  });
});

test("locateSessionPath returns the same project/worktree tuple as locateSessionById", async () => {
  // The wakes consumer uses the cheap path-only variant to avoid
  // re-reading the full session state on every tick. The two
  // locators must agree on the resolved (projectId, worktreePath)
  // tuple.
  await withTempHome(async (home) => {
    const proj = path.join(home, "p");
    mkdirSync(path.join(projectStoreDir(proj), "sessions"), { recursive: true });
    writeFileSync(
      path.join(projectStoreDir(proj), "sessions", "s1.json"),
      JSON.stringify({ id: "s1", workingDirectory: proj })
    );
    await plantProject(home, "proj-1", "demo", proj);
    const full = await locateSessionById("s1");
    const cheap = await locateSessionPath("s1");
    assert.ok(full);
    assert.ok(cheap);
    assert.equal(cheap?.projectId, full?.projectId);
    assert.equal(cheap?.worktreePath, full?.worktreePath);
    assert.equal(cheap?.worktreeId, full?.worktreeId);
  });
});

test("locateSessionPath returns null when the session is unknown", async () => {
  await withTempHome(async () => {
    assert.equal(await locateSessionPath("missing"), null);
  });
});