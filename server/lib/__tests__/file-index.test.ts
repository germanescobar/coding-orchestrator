import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  buildFileIndex,
  clampInt,
  MENTION_WALK_DENYLIST,
} from "../file-index.ts";

/*
 * Recursive file/directory walk for the `@`-mention picker (issue #312).
 * The user-reported gap was "nested files and folders are not listed":
 * the original implementation only fetched the directory the typed
 * token descended into, so `@lib` showed nothing under `client/src/lib`.
 * The fix is a flat recursive walk (BFS, bounded by depth + node count,
 * with a denylist of directories that should never be mentioned). These
 * tests pin the bounds and the denylist so the picker can rely on a
 * stable contract: typing `@lib` returns the same list whether the
 * worktree is the one true monorepo or a fresh scratch repo.
 */

async function withWorktree<T>(
  fn: (root: string) => Promise<T>
): Promise<T> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "file-index-test-"));
  try {
    return await fn(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

test("buildFileIndex lists nested files and directories", async () => {
  await withWorktree(async (root) => {
    // A small repo-shaped tree: a deep directory and a sibling.
    await fs.mkdir(path.join(root, "client", "src", "lib"), {
      recursive: true,
    });
    await fs.mkdir(path.join(root, "server", "lib"), { recursive: true });
    await fs.writeFile(path.join(root, "vite.config.ts"), "// vite\n");
    await fs.writeFile(
      path.join(root, "client", "src", "lib", "skill-picker.ts"),
      "// skill picker\n"
    );
    await fs.writeFile(
      path.join(root, "server", "lib", "sessions.ts"),
      "// sessions\n"
    );

    const result = await buildFileIndex(root, 8, 100);
    const paths = result.entries.map((entry) => entry.relativePath).sort();
    assert.deepEqual(paths, [
      "client",
      "client/src",
      "client/src/lib",
      "client/src/lib/skill-picker.ts",
      "server",
      "server/lib",
      "server/lib/sessions.ts",
      "vite.config.ts",
    ]);
    assert.equal(result.truncated, false);
  });
});

test("buildFileIndex prunes denylisted directories", async () => {
  await withWorktree(async (root) => {
    // A `node_modules` subtree is the canonical example: it can
    // contain thousands of entries, and the user never wants to
    // mention one. The denylist must prune the whole subtree, not
    // just skip the directory itself.
    await fs.mkdir(path.join(root, "node_modules", "react"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(root, "node_modules", "react", "index.js"),
      "// react\n"
    );
    await fs.mkdir(path.join(root, "src"), { recursive: true });
    await fs.writeFile(path.join(root, "src", "index.ts"), "// src\n");
    await fs.mkdir(path.join(root, ".git", "objects"), { recursive: true });
    await fs.writeFile(
      path.join(root, ".git", "objects", "abc123"),
      "blob\n"
    );
    await fs.mkdir(path.join(root, "dist"), { recursive: true });
    await fs.writeFile(path.join(root, "dist", "bundle.js"), "// bundle\n");

    const result = await buildFileIndex(root, 8, 100);
    const paths = result.entries.map((entry) => entry.relativePath).sort();
    assert.deepEqual(paths, ["src", "src/index.ts"]);
    // Sanity: the denylist must include the common offenders; if a
    // future change removes one, the test above will catch it.
    for (const offender of [
      "node_modules",
      ".git",
      "dist",
      "build",
      "coverage",
    ]) {
      assert.ok(
        MENTION_WALK_DENYLIST.has(offender),
        `denylist must include ${offender}`
      );
    }
  });
});

test("buildFileIndex respects the depth cap", async () => {
  await withWorktree(async (root) => {
    // The walk reads the root, lists its entries, and recurses into
    // each subdirectory with `depthLeft - 1`. With `depth=4` the
    // walk visits 5 directory levels (`root`, `a`, `a/a`, `a/a/a`,
    // `a/a/a/a`) and lists every entry at each level. The directory
    // `a/a/a/a/a` is listed as an entry of `a/a/a/a`, but its
    // contents are never read — so a file inside it is not in the
    // result, and a subdirectory of it is not listed.
    let cursor = root;
    for (let i = 0; i < 12; i += 1) {
      cursor = path.join(cursor, "a");
      await fs.mkdir(cursor, { recursive: true });
    }
    // The leaf at depth 4 (`a/a/a/a/leaf.ts`) is at the deepest
    // visited level and must be included. The leaf at depth 5
    // (`a/a/a/a/a/leaf.ts`) lives in a directory whose contents
    // are never read, so it must not be in the result.
    await fs.writeFile(
      path.join(root, "a", "a", "a", "a", "leaf.ts"),
      "// shallow leaf\n"
    );
    await fs.writeFile(path.join(cursor, "leaf.ts"), "// deep leaf\n");

    const result = await buildFileIndex(root, 4, 100);
    const paths = result.entries.map((entry) => entry.relativePath);
    // 5 directory levels + the shallow leaf = 6 entries. The deep
    // leaf is below the depth cap and not in the result.
    assert.equal(result.entries.length, 6);
    assert.ok(
      result.entries.some(
        (entry) => entry.relativePath === "a/a/a/a/leaf.ts"
      ),
      "leaf at the deepest visited level must be included"
    );
    assert.ok(
      !result.entries.some(
        (entry) => entry.relativePath === "a/a/a/a/a/leaf.ts"
      ),
      "leaf below the depth cap must not be included"
    );
  });
});

test("buildFileIndex respects the node cap and flags truncation", async () => {
  await withWorktree(async (root) => {
    // 50 sibling files at the root. With limit=10 the walk must
    // truncate and stop early so the response stays bounded.
    for (let i = 0; i < 50; i += 1) {
      await fs.writeFile(path.join(root, `file-${i}.ts`), "// x\n");
    }
    const result = await buildFileIndex(root, 1, 10);
    assert.equal(result.entries.length, 10);
    assert.equal(result.truncated, true);
  });
});

test("buildFileIndex returns an empty result for an empty worktree", async () => {
  await withWorktree(async (root) => {
    const result = await buildFileIndex(root, 8, 100);
    assert.equal(result.entries.length, 0);
    assert.equal(result.truncated, false);
  });
});

test("clampInt clamps into the requested range", () => {
  assert.equal(clampInt(undefined, 5, 1, 10), 5);
  assert.equal(clampInt("", 5, 1, 10), 5);
  assert.equal(clampInt("3", 5, 1, 10), 3);
  assert.equal(clampInt("0", 5, 1, 10), 1);
  assert.equal(clampInt("99", 5, 1, 10), 10);
  // Non-integer / NaN / non-numeric inputs fall back to the default
  // rather than crashing the route handler.
  assert.equal(clampInt("abc", 5, 1, 10), 5);
  assert.equal(clampInt("1.5", 5, 1, 10), 5);
});
