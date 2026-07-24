/*
 * Tests for the default directory skip list (issue #313).
 *
 * The skip list is the single source of truth for which directories
 * the file finder / file tree won't descend into. Adding a directory
 * here is a deliberate UX decision, so a small regression test that
 * pins the shape of the list and the helper API is worthwhile.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  EXCLUDED_DIRECTORIES,
  shouldExcludeDirectory,
} from "./file-excludes.ts";

test("shouldExcludeDirectory returns true for every entry in the list", () => {
  // The list is a `Set` so this is tautological, but it pins the
  // contract: a name in the list is always excluded. If we ever
  // add a per-directory opt-out (e.g. user-marked exceptions) the
  // logic will move here.
  for (const name of EXCLUDED_DIRECTORIES) {
    assert.equal(shouldExcludeDirectory(name), true, `${name} should be excluded`);
  }
});

test("shouldExcludeDirectory returns false for normal project files", () => {
  // Common project files / directories that should NOT be excluded.
  // If you add a name to the skip list, double-check this list — a
  // typo would silently hide a project layout.
  const allowed = [
    "src",
    "lib",
    "test",
    "tests",
    "docs",
    "scripts",
    "client",
    "server",
    "shared",
    "electron",
    "components",
    "pages",
    "api",
  ];
  for (const name of allowed) {
    assert.equal(shouldExcludeDirectory(name), false, `${name} should NOT be excluded`);
  }
});

test("excludes the most common dependency / build directories", () => {
  // Pin the high-traffic entries. If a future refactor decides to
  // rename `node_modules` or `dist`, this test will catch the
  // intent regression before users do.
  for (const expected of [
    "node_modules",
    ".git",
    "dist",
    "build",
    "out",
    "coverage",
    "__pycache__",
    "target",
  ]) {
    assert.ok(
      EXCLUDED_DIRECTORIES.has(expected),
      `expected ${expected} to be in the skip list`,
    );
  }
});

test("excludes both leading-dot and bare variants", () => {
  // Some entries are leading-dot (`.git`, `.cache`), others are
  // bare (`node_modules`, `dist`). The list should cover both
  // styles — pin a few of each here.
  const leadingDot = [".git", ".cache", ".idea", ".next"];
  const bare = ["node_modules", "dist", "build", "target", "coverage"];
  for (const name of [...leadingDot, ...bare]) {
    assert.equal(shouldExcludeDirectory(name), true);
  }
});

test("is case-sensitive (matches editor convention)", () => {
  // VS Code and Sublime both match the exact basename case. We
  // follow suit so a directory literally named `Node_Modules`
  // (weird but legal on case-sensitive filesystems) is still
  // walked. Pin the behaviour.
  assert.equal(shouldExcludeDirectory("Node_Modules"), false);
  assert.equal(shouldExcludeDirectory("DIST"), false);
  assert.equal(shouldExcludeDirectory("node_modules"), true);
});
