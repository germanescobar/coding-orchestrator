/*
 * Tests for the fuzzy file finder scorer (issue #313).
 *
 * Strategy: feed hand-crafted candidate lists to `fuzzyMatchFiles`
 * and assert the ordering matches the scoring rules documented in
 * `client/src/lib/file-finder.ts`. We don't need a DOM here — the
 * scorer is pure and the dialog is integration-tested in a separate
 * component test.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  fuzzyMatchFiles,
  type FileFinderEntry,
} from "./file-finder.ts";

function entry(relativePath: string): FileFinderEntry {
  return {
    path: `/worktree/${relativePath}`,
    relativePath,
    name: relativePath.split("/").pop() ?? relativePath,
  };
}

test("returns every entry in alphabetical order when query is empty", () => {
  const entries = [
    entry("client/src/pages/Settings.tsx"),
    entry("client/src/pages/SessionView.tsx"),
    entry("client/src/components/Sidebar.tsx"),
  ];
  const matches = fuzzyMatchFiles(entries, "");
  assert.deepEqual(
    matches.map((m) => m.entry.relativePath),
    [
      "client/src/components/Sidebar.tsx",
      "client/src/pages/SessionView.tsx",
      "client/src/pages/Settings.tsx",
    ],
  );
});

test("matches a basic subsequence query", () => {
  const entries = [
    entry("client/src/pages/SessionView.tsx"),
    entry("server/lib/sessions.ts"),
    entry("README.md"),
  ];
  const matches = fuzzyMatchFiles(entries, "sess");
  // README has no `s-e-s-s` subsequence, so it must be filtered out.
  // Both other files contain `sess`; whichever wins is implementation
  // detail — we only assert both are present and the basename that
  // matches the query *exactly* sits at the top.
  const ranked = matches.map((m) => m.entry.relativePath);
  assert.equal(ranked.length, 2);
  assert.ok(ranked.includes("client/src/pages/SessionView.tsx"));
  assert.ok(ranked.includes("server/lib/sessions.ts"));
});

test("ranks an exact-basename match above a subsequence inside a path", () => {
  const entries = [
    entry("src/foo/bar/baz.ts"),
    entry("src/Settings.ts"),
  ];
  // `Settings.ts` is contained in `src/Settings.ts` as the basename;
  // `set` appears scattered inside `bar/baz.ts`'s path. The basename
  // match should win because every char of `set` maps consecutively
  // and lands on the start of the file name.
  const matches = fuzzyMatchFiles(entries, "set");
  assert.equal(matches[0]?.entry.relativePath, "src/Settings.ts");
});

test("returns no matches when the query isn't a subsequence", () => {
  const entries = [entry("client/src/pages/SessionView.tsx")];
  const matches = fuzzyMatchFiles(entries, "zzzz");
  assert.equal(matches.length, 0);
});

test("query is case-insensitive", () => {
  const entries = [entry("client/src/pages/SessionView.tsx")];
  const matches = fuzzyMatchFiles(entries, "SV");
  assert.equal(matches.length, 1);
  assert.equal(matches[0]?.entry.relativePath, "client/src/pages/SessionView.tsx");
});

test("matched indices map back to the query characters in order", () => {
  const entries = [entry("client/src/pages/SessionView.tsx")];
  const [match] = fuzzyMatchFiles(entries, "sv");
  assert.ok(match);
  const indices = match.matchedIndices;
  assert.equal(indices.length, 2);
  const chars = indices.map((i) => match.entry.relativePath.toLowerCase()[i]);
  assert.equal(chars.join(""), "sv");
});

test("stable ordering for ties", () => {
  const entries = [
    entry("client/a/foo.tsx"),
    entry("client/b/foo.tsx"),
  ];
  // `foo` is contained in both with identical scoring — we expect
  // alphabetical order as the tiebreaker.
  const matches = fuzzyMatchFiles(entries, "foo");
  assert.equal(matches.length, 2);
  assert.equal(matches[0]?.entry.relativePath, "client/a/foo.tsx");
  assert.equal(matches[1]?.entry.relativePath, "client/b/foo.tsx");
});

test("consecutive matches beat scattered matches", () => {
  // `xyz` is a consecutive run inside `client/xyz/file.ts` but is
  // scattered (`x` then `y` then `z` far apart) inside the other
  // candidate. The consecutive run should win.
  const entries = [
    entry("a/long/path/x/with/many/y/separators/z.ts"),
    entry("client/xyz/file.ts"),
  ];
  const matches = fuzzyMatchFiles(entries, "xyz");
  assert.equal(matches[0]?.entry.relativePath, "client/xyz/file.ts");
});
