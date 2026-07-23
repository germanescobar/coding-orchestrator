/**
 * Pure helpers for the composer's `@` file/directory mention picker, isolated
 * from React so they can be unit-tested with the `node --import tsx --test`
 * runner.
 *
 * Two capabilities live here (issue #312):
 *
 *  - Position-agnostic parsing: the picker scans the token at the caret rather
 *    than only the start of the input, so `@` opens the picker from any
 *    position that begins a new token.
 *  - Reproducible context assembly: the orchestrator rewrites each mention
 *    into a `<mentions>...</mentions>` block prepended to the agent prompt
 *    (and persisted to history verbatim), so two runs that mention the same
 *    files produce identical prompts — a precondition for session replay
 *    determinism.
 */

/**
 * A mention of a single file or directory inside the active worktree.
 * `path` is the repo-relative path the user typed after `@` (no leading
 * `./`); the backend resolves it against the worktree root and re-checks
 * the path is inside the worktree before reading anything.
 */
export interface FileMention {
  path: string;
  type: "file" | "directory";
}

/** A token looks like a file mention only if it is exactly `@<path>`. */
const MENTION_TOKEN = /^@([A-Za-z0-9._\-\/]*)$/;

/**
 * Parse the in-progress file-mention token at the caret. Whitespace and the
 * start of the string are token boundaries; the current token is the
 * trailing run of non-whitespace characters before the caret. Returns null
 * when that token does not look like an `@<path>` invocation — an `@` inside
 * an email address or a non-path word is preceded by non-whitespace, so its
 * token never matches `^@<path>$`.
 *
 * Paths are intentionally restricted to characters that are valid in a
 * repo-relative file path: letters, digits, dot, dash, underscore, and
 * forward slash. A trailing slash (the directory convention used by the
 * picker UI) is preserved in the token so the backend can resolve it as a
 * directory rather than a file.
 */
export function parseMentionTokenAtCaret(
  message: string,
  caret: number
): { token: string; start: number; end: number; trailingSlash: boolean } | null {
  const clamped = Math.max(0, Math.min(caret, message.length));
  const before = message.slice(0, clamped);
  const run = /(\S*)$/.exec(before);
  if (!run) return null;
  const tokenText = run[1];
  const start = run.index;
  const match = MENTION_TOKEN.exec(tokenText);
  if (!match) return null;
  const token = match[1];
  const trailingSlash = token.endsWith("/");
  return { token, start, end: clamped, trailingSlash };
}

/**
 * Remove the in-progress `@<token>` from the message, returning the cleaned
 * message and the caret position where the token started. Mirrors the
 * slash-command behavior: prose is preserved verbatim, and the seam left by
 * removing a mid-message token is collapsed so the composer does not show a
 * dangling space.
 */
export function removeMentionToken(
  message: string,
  token: { start: number; end: number }
): { message: string; caret: number } {
  const before = message.slice(0, token.start);
  let after = message.slice(token.end);
  if (before === "") {
    after = after.replace(/^\s+/, "");
  } else if (/\s$/.test(before) && /^\s/.test(after)) {
    after = after.replace(/^\s+/, "");
  }
  return { message: before + after, caret: before.length };
}

/**
 * Build the prompt-side context block for a set of file mentions. The block
 * is deterministic (same mentions → same string) so two runs that mention
 * the same files produce identical prompts — a precondition for session
 * replay determinism (issue #312 acceptance criteria). The backend appends
 * this to the agent message before spawning, and persists it verbatim to
 * history so the user sees the resolved context on reload.
 */
export function buildMentionContextBlock(mentions: FileMention[]): string {
  if (mentions.length === 0) return "";
  const lines = mentions.map((mention) => `- ${mention.type}: ${mention.path}`);
  return [
    "<mentions>",
    "The user referenced the following paths in the active worktree. Their",
    "contents are available via the agent's file-reading tools; resolve",
    "each path with the worktree root as the base directory.",
    ...lines,
    "</mentions>",
  ].join("\n");
}

/**
 * Fuzzy-match a needle against a candidate path. Returns a score; higher is
 * better; `null` means "no match". The scoring is intentionally simple and
 * stable so the picker's order does not jitter between keystrokes:
 *
 *  - Exact path match: 1000
 *  - Path starts with the needle: 500 - delta (shorter path ranks higher)
 *  - Substring match (anywhere in the path): 100
 *  - Character-order subsequence: 50 - number of unmatched chars
 *  - Otherwise: null
 *
 * Directory matches get a +5 boost so a `/src/components` query prefers
 * `src/components` (a directory the user might have just expanded) over a
 * `src/components.tsx` file with the same prefix.
 */
export function scoreMentionCandidate(
  needle: string,
  candidate: { relativePath: string; type: "file" | "directory" }
): number | null {
  if (!needle) return 0;
  const lowerNeedle = needle.toLowerCase().replace(/\/+$/, "");
  const lowerCandidate = candidate.relativePath.toLowerCase();
  if (lowerCandidate === lowerNeedle) {
    return 1000 + (candidate.type === "directory" ? 5 : 0);
  }
  if (lowerCandidate.startsWith(`${lowerNeedle}/`)) {
    const segments = lowerCandidate.split("/").length;
    return 500 - segments + (candidate.type === "directory" ? 5 : 0);
  }
  if (lowerCandidate.startsWith(lowerNeedle)) {
    return 250 + (candidate.type === "directory" ? 5 : 0);
  }
  const substringIndex = lowerCandidate.indexOf(lowerNeedle);
  if (substringIndex !== -1) {
    return 100 - substringIndex + (candidate.type === "directory" ? 5 : 0);
  }
  let i = 0;
  for (const ch of lowerCandidate) {
    if (ch === lowerNeedle[i]) i += 1;
    if (i === lowerNeedle.length) break;
  }
  if (i === lowerNeedle.length) {
    return 50 - (lowerCandidate.length - lowerNeedle.length) + (candidate.type === "directory" ? 5 : 0);
  }
  return null;
}

/**
 * Coerce a picker token to a repo-relative path. Strips a leading `./`
 * and a trailing slash (the picker uses trailing slashes as a directory
 * hint, but the backend normalizes the result anyway). Returns an empty
 * string when the token is empty after normalization.
 */
export function normalizeMentionPath(token: string): string {
  return token.replace(/^\.\/+/, "").replace(/\/+$/, "");
}

/**
 * Infer the type a token is hinting at. The picker UI uses a trailing
 * `/` to signal "this is a directory"; an empty token (the picker is
 * still showing the unfiltered root) is ambiguous and defaults to file.
 */
export function inferMentionType(
  token: string,
  trailingSlash: boolean
): "file" | "directory" {
  if (trailingSlash) return "directory";
  if (!token) return "file";
  return "file";
}
