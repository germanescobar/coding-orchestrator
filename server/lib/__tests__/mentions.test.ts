import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  resolveMentions,
  parseMentionsQuery,
} from "../mentions.ts";

/*
 * Server-side resolver for `@`-mention chips (issue #312). The resolver
 * is the authorization + assembly layer: it re-validates every path
 * against the worktree root, inlines a short preview, and renders a
 * deterministic `<mentions>...</mentions>` block the agent prompt and
 * the persisted history can both consume byte-for-byte.
 *
 * These tests cover the security boundary (a path outside the worktree
 * must be skipped, not inlined), the deterministic output (same input
 * must produce the same block — replay determinism is an acceptance
 * criterion), and the error annotations (a missing file is recorded as
 * a one-line note, not a turn-failing exception).
 */

async function withWorktree<T>(
  fn: (worktreePath: string) => Promise<T>
): Promise<T> {
  const worktreePath = await fs.mkdtemp(
    path.join(os.tmpdir(), "mentions-test-")
  );
  try {
    return await fn(worktreePath);
  } finally {
    await fs.rm(worktreePath, { recursive: true, force: true });
  }
}

test("resolveMentions returns empty block for an empty list", async () => {
  const result = await resolveMentions("/tmp", []);
  assert.deepEqual(result, {
    mentions: [],
    contextBlock: "",
    prefix: "",
  });
});

test("resolveMentions inlines a short preview for a known file", async () => {
  await withWorktree(async (worktreePath) => {
    const target = path.join(worktreePath, "src", "index.ts");
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, "export const x = 1;\n");

    const result = await resolveMentions(worktreePath, [
      { path: "src/index.ts", type: "file" },
    ]);
    assert.equal(result.mentions.length, 1);
    assert.equal(result.mentions[0].path, "src/index.ts");
    // The deterministic block is the listing the persisted history
    // carries — it must NOT include the preview, so two runs that
    // mention the same file produce identical transcripts.
    assert.ok(result.contextBlock.startsWith("<mentions>"));
    assert.ok(result.contextBlock.endsWith("</mentions>"));
    assert.ok(
      result.contextBlock.includes("- file: src/index.ts"),
      "context block should list the resolved path"
    );
    assert.ok(
      !result.contextBlock.includes("export const x"),
      "context block must not include the file preview"
    );
    // The agent-prompt prefix carries the preview so the agent can
    // ground its response without an extra round trip.
    assert.ok(
      result.prefix.includes("export const x = 1;"),
      "prefix must include the file preview"
    );
  });
});

test("resolveMentions skips a file that lives outside the worktree", async () => {
  await withWorktree(async (worktreePath) => {
    const outsideDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "mentions-outside-")
    );
    try {
      const outsideFile = path.join(outsideDir, "secret.ts");
      await fs.writeFile(outsideFile, "top secret\n");
      // The picker only ships repo-relative paths, but the orchestrator
      // re-validates with `path.resolve(worktreePath, …)`. To exercise
      // the security boundary we have to feed the resolver an absolute
      // path that escapes — which is exactly the kind of input a
      // hand-crafted URL would produce.
      const result = await resolveMentions(worktreePath, [
        { path: outsideFile, type: "file" },
      ]);
      assert.equal(result.mentions.length, 0);
      assert.ok(
        result.contextBlock.includes("(skipped: outside worktree)"),
        "outside-worktree mention must be annotated, not inlined"
      );
    } finally {
      await fs.rm(outsideDir, { recursive: true, force: true });
    }
  });
});

test("resolveMentions records a missing path as an annotation", async () => {
  await withWorktree(async (worktreePath) => {
    const result = await resolveMentions(worktreePath, [
      { path: "src/does-not-exist.ts", type: "file" },
    ]);
    assert.equal(result.mentions.length, 0);
    assert.ok(
      result.contextBlock.includes("(skipped: not found)"),
      "missing-file mention must be annotated, not inlined"
    );
  });
});

test("resolveMentions rejects a path that escapes the worktree", async () => {
  await withWorktree(async (worktreePath) => {
    // The escape target must exist so `realpath` succeeds and the
    // boundary check (not the ENOENT handler) is what rejects the
    // path. We create the file outside the worktree, then point the
    // resolver at a relative path that resolves through it.
    const outsideDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "mentions-escape-")
    );
    try {
      await fs.writeFile(path.join(outsideDir, "secret.ts"), "x\n");
      const result = await resolveMentions(worktreePath, [
        // `..` is allowed by the path-safety regex (it's a normal
        // relative segment) but `path.resolve` lands the target
        // outside the worktree, so the boundary check is what
        // catches it.
        {
          path: `${path.relative(worktreePath, outsideDir)}/secret.ts`,
          type: "file",
        },
      ]);
      assert.equal(result.mentions.length, 0);
      assert.ok(
        result.contextBlock.includes("(skipped: outside worktree)"),
        "relative-`..` mention must be annotated by the boundary check"
      );
    } finally {
      await fs.rm(outsideDir, { recursive: true, force: true });
    }
  });
});

test("resolveMentions rejects a path with characters that can escape the worktree", async () => {
  await withWorktree(async (worktreePath) => {
    const result = await resolveMentions(worktreePath, [
      // The path-safety regex blocks characters that have no place in
      // a repo-relative path. A backslash would let a Windows-style
      // path bypass the `/`-only regex on the client; the server must
      // refuse it before `path.resolve` ever runs.
      { path: "src\\..\\secret.ts", type: "file" },
    ]);
    assert.equal(result.mentions.length, 0);
    assert.ok(
      result.contextBlock.includes("(skipped: invalid path)"),
      "path with backslash must be annotated as invalid"
    );
  });
});

test("resolveMentions lists a directory's children in the preview", async () => {
  await withWorktree(async (worktreePath) => {
    const dir = path.join(worktreePath, "src");
    await fs.mkdir(path.join(dir, "a"), { recursive: true });
    await fs.writeFile(path.join(dir, "b.ts"), "export const b = 1;\n");
    const result = await resolveMentions(worktreePath, [
      { path: "src", type: "directory" },
    ]);
    assert.equal(result.mentions.length, 1);
    assert.equal(result.mentions[0].type, "directory");
    // The preview lists the directory's children so the agent knows
    // what's inside; the resolved path is what the agent joins with
    // the worktree root to read the entries themselves.
    assert.ok(result.prefix.includes("a/"), "preview must list subdirectories");
    assert.ok(result.prefix.includes("b.ts"), "preview must list files");
  });
});

test("resolveMentions is deterministic for the same input", async () => {
  await withWorktree(async (worktreePath) => {
    await fs.writeFile(
      path.join(worktreePath, "a.ts"),
      "export const a = 1;\n"
    );
    const input = [{ path: "a.ts", type: "file" as const }];
    const a = await resolveMentions(worktreePath, input);
    const b = await resolveMentions(worktreePath, input);
    // The block is persisted to history verbatim; if it jitters between
    // runs, session replay is no longer reproducible.
    assert.equal(a.contextBlock, b.contextBlock);
  });
});

test("parseMentionsQuery parses the wire format", () => {
  assert.deepEqual(parseMentionsQuery(""), []);
  assert.deepEqual(parseMentionsQuery(undefined), []);
  assert.deepEqual(parseMentionsQuery("server/lib/sessions.ts|file"), [
    { path: "server/lib/sessions.ts", type: "file" },
  ]);
  assert.deepEqual(
    parseMentionsQuery(
      "server/lib|directory,client/src/api.ts|file"
    ),
    [
      { path: "server/lib", type: "directory" },
      { path: "client/src/api.ts", type: "file" },
    ]
  );
  // Missing or unknown types default to `file` so a hand-crafted URL
  // still parses.
  assert.deepEqual(parseMentionsQuery("client/src/api.ts"), [
    { path: "client/src/api.ts", type: "file" },
  ]);
  // Bad rows (empty path) are dropped silently.
  assert.deepEqual(parseMentionsQuery("|file,client/src/api.ts"), [
    { path: "client/src/api.ts", type: "file" },
  ]);
});
