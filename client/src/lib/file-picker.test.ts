import test from "node:test";
import assert from "node:assert/strict";
import {
  parseMentionTokenAtCaret,
  removeMentionToken,
  buildMentionContextBlock,
  scoreMentionCandidate,
  normalizeMentionPath,
  inferMentionType,
} from "./file-picker.ts";

// --- parseMentionTokenAtCaret ---------------------------------------------

test("opens for an `@` token at the start of the input", () => {
  const message = "@server/lib";
  const token = parseMentionTokenAtCaret(message, message.length);
  assert.deepEqual(token, {
    token: "server/lib",
    start: 0,
    end: 11,
    trailingSlash: false,
  });
});

test("opens for a bare `@` (empty query shows every entry)", () => {
  const token = parseMentionTokenAtCaret("@", 1);
  assert.deepEqual(token, {
    token: "",
    start: 0,
    end: 1,
    trailingSlash: false,
  });
});

test("opens for an `@` token mid-message at the caret", () => {
  const message = "look at @server/lib/sessions";
  const token = parseMentionTokenAtCaret(message, message.length);
  assert.deepEqual(token, {
    token: "server/lib/sessions",
    start: 8,
    end: 28,
    trailingSlash: false,
  });
});

test("uses the token at the caret, not an `@` token later in the string", () => {
  // Caret sits inside the prose word "something"; the `@server/lib` earlier
  // in the line is not the current token, so the picker stays closed.
  const message = "@server/lib do something";
  const token = parseMentionTokenAtCaret(message, message.length);
  assert.equal(token, null);
});

test("does not open for an `@` inside an email address", () => {
  // The token before the caret is `user@example`, not `@example` — the
  // @ is preceded by non-whitespace (`user`), so it is not a token boundary.
  assert.equal(parseMentionTokenAtCaret("contact user@example", 19), null);
});

test("recognizes a trailing slash as a directory hint", () => {
  const message = "@src/components/";
  const token = parseMentionTokenAtCaret(message, message.length);
  assert.deepEqual(token, {
    token: "src/components/",
    start: 0,
    end: 16,
    trailingSlash: true,
  });
});

test("only considers text up to the caret", () => {
  const message = "@server/lib extra";
  // Caret right after `@server/lib`, before the rest is typed.
  const token = parseMentionTokenAtCaret(message, 11);
  assert.deepEqual(token, {
    token: "server/lib",
    start: 0,
    end: 11,
    trailingSlash: false,
  });
});

test("rejects paths with characters not valid in repo-relative paths", () => {
  assert.equal(parseMentionTokenAtCaret("@bad path", 9), null);
  assert.equal(parseMentionTokenAtCaret("@bad\\path", 9), null);
});

// --- removeMentionToken ---------------------------------------------------

test("removeMentionToken strips a position-0 token and leading space", () => {
  const message = "@server/lib rest of message";
  const token = parseMentionTokenAtCaret(message, 11)!;
  assert.deepEqual(removeMentionToken(message, token), {
    message: "rest of message",
    caret: 0,
  });
});

test("removeMentionToken preserves prose before a mid-message token", () => {
  const message = "look at @server/lib/sessions";
  const token = parseMentionTokenAtCaret(message, message.length)!;
  assert.deepEqual(removeMentionToken(message, token), {
    message: "look at ",
    caret: 8,
  });
});

test("removeMentionToken collapses the seam between surrounding spaces", () => {
  const message = "look @server more";
  const token = parseMentionTokenAtCaret(message, 12)!;
  assert.deepEqual(removeMentionToken(message, token), {
    message: "look more",
    caret: 5,
  });
});

// --- buildMentionContextBlock --------------------------------------------

test("buildMentionContextBlock returns empty for no mentions", () => {
  assert.equal(buildMentionContextBlock([]), "");
});

test("buildMentionContextBlock renders a deterministic XML block", () => {
  const block = buildMentionContextBlock([
    { path: "server/lib/sessions.ts", type: "file" },
    { path: "client/src/components", type: "directory" },
  ]);
  // The exact text is part of the agent prompt and is persisted to history
  // verbatim; any change here is a prompt-ABI break. Pin it so a future
  // reformat has to be deliberate.
  assert.equal(
    block,
    [
      "<mentions>",
      "The user referenced the following paths in the active worktree. Their",
      "contents are available via the agent's file-reading tools; resolve",
      "each path with the worktree root as the base directory.",
      "- file: server/lib/sessions.ts",
      "- directory: client/src/components",
      "</mentions>",
    ].join("\n")
  );
});

test("buildMentionContextBlock is order-insensitive on input but order-preserving on output", () => {
  // The order of mentions in the block must match the order the user added
  // them; two runs that mention the same files in a different order
  // produce different prompts (the backend sorts by the request's order).
  const a = buildMentionContextBlock([
    { path: "a.ts", type: "file" },
    { path: "b.ts", type: "file" },
  ]);
  const b = buildMentionContextBlock([
    { path: "b.ts", type: "file" },
    { path: "a.ts", type: "file" },
  ]);
  assert.notEqual(a, b);
});

// --- scoreMentionCandidate -----------------------------------------------

test("scoreMentionCandidate ranks exact match highest", () => {
  const exact = scoreMentionCandidate("src/index.ts", {
    relativePath: "src/index.ts",
    type: "file",
  });
  const prefix = scoreMentionCandidate("src/", {
    relativePath: "src/index.ts",
    type: "file",
  });
  assert.ok(exact !== null && prefix !== null && exact > prefix);
});

test("scoreMentionCandidate prefers shorter paths when the needle is a prefix", () => {
  const top = scoreMentionCandidate("src", {
    relativePath: "src/index.ts",
    type: "file",
  });
  const nested = scoreMentionCandidate("src", {
    relativePath: "src/components/Button.tsx",
    type: "file",
  });
  assert.ok(top !== null && nested !== null && top > nested);
});

test("scoreMentionCandidate boosts directories over same-prefixed files", () => {
  const dir = scoreMentionCandidate("src/components", {
    relativePath: "src/components",
    type: "directory",
  });
  const file = scoreMentionCandidate("src/components", {
    relativePath: "src/components.tsx",
    type: "file",
  });
  assert.ok(dir !== null && file !== null && dir > file);
});

test("scoreMentionCandidate returns null when there is no match", () => {
  assert.equal(
    scoreMentionCandidate("zzz", {
      relativePath: "src/index.ts",
      type: "file",
    }),
    null
  );
});

test("scoreMentionCandidate falls back to subsequence match for typos", () => {
  // The needle `srs` appears as a subsequence of `sessions` — fuzzy enough
  // to be useful, but the score is much lower than an exact match.
  const score = scoreMentionCandidate("srs", {
    relativePath: "server/sessions.ts",
    type: "file",
  });
  const exact = scoreMentionCandidate("sessions", {
    relativePath: "server/sessions.ts",
    type: "file",
  });
  assert.ok(score !== null && exact !== null && exact > score);
});

// --- normalizeMentionPath ------------------------------------------------

test("normalizeMentionPath strips leading `./` and trailing `/`", () => {
  assert.equal(normalizeMentionPath("./src/lib"), "src/lib");
  assert.equal(normalizeMentionPath("src/lib/"), "src/lib");
  assert.equal(normalizeMentionPath("./src/lib/"), "src/lib");
  assert.equal(normalizeMentionPath(""), "");
});

// --- inferMentionType ----------------------------------------------------

test("inferMentionType reads trailing slash as a directory hint", () => {
  assert.equal(inferMentionType("src/components/", true), "directory");
  assert.equal(inferMentionType("src/components", false), "file");
  assert.equal(inferMentionType("", false), "file");
});
