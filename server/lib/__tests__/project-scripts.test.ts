import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  buildScriptEnv,
  buildTerminalScriptCommand,
  resolveNativeScriptDir,
  resolveProjectScripts,
} from "../project-scripts.js";

function makeContext(overrides: {
  portOffset?: number;
  branch?: string;
} = {}) {
  return {
    project: {
      id: "proj-1",
      name: "p",
      path: "/project",
      createdAt: "2026-01-01",
    },
    worktree: {
      id: "wt-1",
      projectId: "proj-1",
      name: "issue-2",
      path: "/project/.worktrees/issue-2",
      isMain: false,
      createdAt: "2026-01-01",
      branch: overrides.branch ?? "issue-2",
      portOffset: overrides.portOffset ?? 6,
    },
  };
}

test("buildScriptEnv exports port offset without project port defaults", () => {
  const env = buildScriptEnv(makeContext());
  assert.equal(env.PORT_OFFSET, "6");
  assert.equal(env.CLIENT_BASE_PORT, undefined);
  assert.equal(env.API_BASE_PORT, undefined);
});

test("buildScriptEnv uses zero port offset for main worktree", () => {
  const env = buildScriptEnv(makeContext({ portOffset: 0, branch: "main" }));
  assert.equal(env.PORT_OFFSET, "0");
  assert.equal(env.BRANCH, "main");
});

test("buildScriptEnv exposes source and worktree paths", () => {
  const env = buildScriptEnv(makeContext());
  assert.equal(env.WORKTREE_PATH, "/project/.worktrees/issue-2");
  assert.equal(env.SOURCE_PATH, "/project");
  assert.equal(env.WORKTREE_NAME, "issue-2");
});

test("buildTerminalScriptCommand returns a single command as-is", () => {
  const command = buildTerminalScriptCommand([
    { command: "bash /p/run.sh", label: "run.sh", source: "native" },
  ]);

  assert.equal(command, "bash /p/run.sh");
});

test("buildTerminalScriptCommand does not inline environment values", () => {
  const command = buildTerminalScriptCommand([
    { command: "bash /p/run.sh", label: "run.sh", source: "native" },
  ]);

  for (const value of ["WORKTREE_PATH=", "PORT_OFFSET=", "CONDUCTOR_", "SUPERSET_"]) {
    assert.ok(!command.includes(value), `command should not contain ${value}`);
  }
});

test("buildTerminalScriptCommand joins multiple commands with newlines inside one body", () => {
  const command = buildTerminalScriptCommand(
    [
      { command: "echo first", label: "1", source: "native" },
      { command: "echo second", label: "2", source: "native" },
    ]
  );
  assert.ok(command.startsWith("bash -lc '"));
  // The joined body still appears, in order, with newlines intact.
  assert.ok(command.includes("set -e; echo first;\necho second"));
  assert.ok(command.endsWith("'"));
});

// --- Native script resolution (the ".controller" vs ".coding-orchestrator" branch) ---

/*
 * Issue (filed via the in-app "Run" button): a project with an empty
 * `.controller/` directory left over from onboarding was reporting
 * "No run script configured" even though `.coding-orchestrator/run.sh`
 * was on disk. The root cause was `resolveNativeScriptDir` checking
 * `existsSync(.controller)` instead of checking whether the directory
 * actually contains scripts — the legacy fallback was never reached
 * because the empty new-style directory always won the existence
 * check.
 *
 * These tests pin the fix: the resolution prefers `.controller/` only
 * when it has scripts, otherwise falls back to `.coding-orchestrator/`.
 */

async function withProject<T>(
  setup: (root: string) => Promise<void>,
  fn: (root: string) => Promise<T>
): Promise<T> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "project-scripts-"));
  try {
    await setup(root);
    return await fn(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

test("resolveNativeScriptDir prefers .controller when both have scripts", async () => {
  await withProject(
    async (root) => {
      await fs.mkdir(path.join(root, ".controller"), { recursive: true });
      await fs.writeFile(path.join(root, ".controller", "run.sh"), "x\n");
      await fs.mkdir(path.join(root, ".coding-orchestrator"), { recursive: true });
      await fs.writeFile(
        path.join(root, ".coding-orchestrator", "run.sh"),
        "y\n"
      );
    },
    async (root) => {
      assert.equal(
        resolveNativeScriptDir(root),
        path.join(root, ".controller")
      );
    }
  );
});

test("resolveNativeScriptDir falls back to legacy when .controller is empty", async () => {
  // The reported bug: an empty `.controller/` directory was shadowing
  // the populated `.coding-orchestrator/` directory, so the route
  // returned 404 with "No run script configured" for projects that
  // obviously had one. The fix is to require the new-style directory
  // to actually contain scripts before preferring it.
  await withProject(
    async (root) => {
      await fs.mkdir(path.join(root, ".controller"), { recursive: true });
      await fs.mkdir(path.join(root, ".coding-orchestrator"), { recursive: true });
      await fs.writeFile(
        path.join(root, ".coding-orchestrator", "run.sh"),
        "#!/bin/bash\necho legacy\n"
      );
    },
    async (root) => {
      assert.equal(
        resolveNativeScriptDir(root),
        path.join(root, ".coding-orchestrator")
      );
    }
  );
});

test("resolveNativeScriptDir returns .controller when nothing exists", async () => {
  // Fresh project, no scripts on disk: pick the new-style directory
  // so any fresh writes land in the canonical location.
  await withProject(
    async () => {
      // no setup
    },
    async (root) => {
      assert.equal(
        resolveNativeScriptDir(root),
        path.join(root, ".controller")
      );
    }
  );
});

test("resolveProjectScripts returns the legacy run script when .controller is empty", async () => {
  // End-to-end version of the bug repro: the route calls this
  // function with the project path, so a regression here surfaces
  // directly to the user as "No run script configured" for any
  // project that has only legacy scripts and an empty new-style
  // directory. This test pins the resolver so the regression
  // cannot return silently.
  await withProject(
    async (root) => {
      await fs.mkdir(path.join(root, ".controller"), { recursive: true });
      await fs.mkdir(path.join(root, ".coding-orchestrator"), { recursive: true });
      await fs.writeFile(
        path.join(root, ".coding-orchestrator", "run.sh"),
        "#!/bin/bash\necho legacy\n"
      );
      await fs.writeFile(
        path.join(root, ".coding-orchestrator", "setup.sh"),
        "#!/bin/bash\necho legacy\n"
      );
    },
    async (root) => {
      const scripts = await resolveProjectScripts(root);
      assert.equal(scripts.run.length, 1);
      assert.equal(scripts.run[0].label, "run.sh");
      assert.ok(scripts.run[0].command.includes(".coding-orchestrator/run.sh"));
      assert.equal(scripts.setup.length, 1);
    }
  );
});
