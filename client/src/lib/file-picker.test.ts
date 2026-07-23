import test from "node:test";
import assert from "node:assert/strict";
import {
  parseMentionTokenAtCaret,
  removeMentionToken,
  buildMentionContextBlock,
  scoreMentionCandidate,
  normalizeMentionPath,
  inferMentionType,
  parseMentionBlock,
} from "./file-picker.ts";
import { parseSkillMarkers } from "./skill-picker.ts";

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

// --- parseMentionBlock ---------------------------------------------------

test("parseMentionBlock returns no mentions for plain text", () => {
  assert.deepEqual(parseMentionBlock("just a message"), {
    mentions: [],
    text: "just a message",
  });
});

test("parseMentionBlock extracts mentions and strips the block", () => {
  const block = [
    "<mentions>",
    "The user referenced the following paths in the active worktree.",
    "- file: server/lib/sessions.ts",
    "- directory: client/src",
    "</mentions>",
    "",
  ].join("\n");
  assert.deepEqual(parseMentionBlock(`${block}hello world`), {
    mentions: [
      { type: "file", path: "server/lib/sessions.ts" },
      { type: "directory", path: "client/src" },
    ],
    text: "hello world",
  });
});

test("parseMentionBlock parses the block when followed by a skill marker", () => {
  // This is the order the server persists: mention block, then the
  // skill markers, then the user text. The renderer must strip the
  // mention block first (so the skill marker isn't visible as prose)
  // and then the skill markers (so the skill chip can render).
  const payload = [
    "<mentions>",
    "- file: server/lib/sessions.ts",
    "</mentions>",
    "",
    "[/skill: a] [/skill: b] hello",
  ].join("\n");
  const { mentions, text: afterMentions } = parseMentionBlock(payload);
  assert.equal(mentions.length, 1);
  assert.equal(mentions[0].path, "server/lib/sessions.ts");
  // After stripping the block, the remaining text is exactly the
  // shape `parseSkillMarkers` expects (a leading skill marker
  // chain). Compose with the existing skill-picker helper to assert
  // the round-trip — the skill chips must render and the visible
  // text must be just the user text.
  const { skillNames, text: visibleText } = parseSkillMarkers(afterMentions);
  assert.deepEqual(skillNames, ["a", "b"]);
  assert.equal(visibleText, "hello");
});

test("parseMentionBlock tolerates a trailing newline in the closing tag", () => {
  // Round-trips with the server output, which trims a trailing
  // newline when emitting the closing tag.
  const payload = "<mentions>\n- file: a.ts\n</mentions>\nbody";
  const { mentions, text } = parseMentionBlock(payload);
  assert.equal(mentions.length, 1);
  assert.equal(text, "body");
});

test("parseMentionBlock returns no mentions for malformed blocks", () => {
  // Unclosed block: the regex is non-greedy with a closing-tag
  // requirement, so this is treated as "no block" and the text is
  // left untouched. A hand-edited transcript shouldn't crash the
  // renderer.
  assert.deepEqual(
    parseMentionBlock("<mentions>\n- file: a.ts\nbody"),
    { mentions: [], text: "<mentions>\n- file: a.ts\nbody" }
  );
});
