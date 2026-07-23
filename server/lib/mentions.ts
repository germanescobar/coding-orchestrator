/*
 * Server-side resolver for `@`-mention chips (issue #312).
 *
 * The client is the source of truth for what the user typed; this module
 * is the authorization + assembly layer. Every path is re-validated
 * against the active worktree root (a path the user typed in a different
 * project is not a path they can mention in this one), and the resolved
 * mention is rendered as a deterministic `<mentions>...</mentions>`
 * block. That block is prepended to the agent prompt *and* persisted to
 * history verbatim, so two runs that mention the same files produce
 * identical transcripts — the acceptance criterion for replay
 * determinism.
 *
 * The function is a pure transformation over the filesystem: it does
 * not touch the session/event store, and its output is the same
 * regardless of which provider is being spawned. That keeps the call
 * site (the session-start route) provider-agnostic and makes the
 * function easy to unit-test in isolation.
 */
import fs from "node:fs/promises";
import path from "node:path";

export interface ResolvedMention {
  path: string;
  type: "file" | "directory";
}

export interface MentionResolution {
  /** Resolved mentions in the order the user requested them. */
  mentions: ResolvedMention[];
  /**
   * Deterministic `<mentions>...</mentions>` block. Prepended to the
   * agent prompt AND persisted to history verbatim so two runs that
   * mention the same files produce identical prompts.
   */
  contextBlock: string;
  /**
   * Same block plus inline file/directory previews. The agent prompt
   * carries this; the persisted history carries only `contextBlock`
   * (no previews) so the transcript stays byte-identical across
   * runs of the same prompt.
   */
  prefix: string;
}

const MENTION_PREVIEW_LINE_LIMIT = 200;
const MENTION_PREVIEW_BYTE_LIMIT = 8 * 1024;

/**
 * Resolve a list of `@`-mentions against a worktree. Each path is
 * re-validated against the worktree root and a short preview is inlined
 * so the agent can ground its response without an extra round trip.
 *
 * Errors are non-fatal: a missing or unreadable mention is recorded as
 * a one-line annotation in the block rather than failing the whole
 * turn. The user is more likely to fix the path on the next turn than
 * to retry from scratch, and the resolved block still tells the agent
 * what was intended.
 */
export async function resolveMentions(
  worktreePath: string,
  mentions: ResolvedMention[]
): Promise<MentionResolution> {
  if (mentions.length === 0) {
    return { mentions: [], contextBlock: "", prefix: "" };
  }
  const resolved: ResolvedMention[] = [];
  const annotationLines: string[] = [];
  for (const mention of mentions) {
    const cleaned = mention.path.replace(/^\.\/+/, "").replace(/\/+$/, "");
    if (!cleaned) continue;
    // Path-safety check. The original implementation rejected any
    // character outside `[A-Za-z0-9._/-]`, which is over-restrictive:
    // real repo paths can contain spaces, `+`, `()`, `,`, `:`, or
    // non-ASCII characters (`docs/API guide.md`,
    // `テスト/ファイル.md`, `package@1.0/README.md`). The actual
    // safety guarantee comes from `realpath` + the worktree-root
    // boundary check below; the regex here only exists to reject
    // input that would obviously break the resolver's own logic
    // (null bytes, embedded NULs, control characters, backslashes
    // that hint at Windows-style paths on a POSIX system). Length
    // is also bounded so a pathological input can't blow the
    // annotation line buffer.
    if (cleaned.length > 4096) {
      annotationLines.push(
        `- ${mention.type}: ${mention.path} (skipped: path too long)`,
      );
      continue;
    }
    if (/[\0\u0000-\u001f\\]/.test(cleaned)) {
      annotationLines.push(
        `- ${mention.type}: ${mention.path} (skipped: invalid path)`,
      );
      continue;
    }
    const absolutePath = path.isAbsolute(cleaned)
      ? cleaned
      : path.resolve(worktreePath, cleaned);
    try {
      const [targetRealPath, worktreeRealPath] = await Promise.all([
        fs.realpath(absolutePath),
        fs.realpath(worktreePath),
      ]);
      const relativeToWorktree = path.relative(
        worktreeRealPath,
        targetRealPath
      );
      const isInsideWorktree =
        relativeToWorktree === "" ||
        (!relativeToWorktree.startsWith("..") &&
          !path.isAbsolute(relativeToWorktree));
      if (!isInsideWorktree) {
        annotationLines.push(
          `- ${mention.type}: ${mention.path} (skipped: outside worktree)`
        );
        continue;
      }
      const stat = await fs.stat(targetRealPath);
      if (mention.type === "directory" && !stat.isDirectory()) {
        annotationLines.push(
          `- ${mention.type}: ${mention.path} (skipped: not a directory)`
        );
        continue;
      }
      if (mention.type === "file" && !stat.isFile()) {
        annotationLines.push(
          `- ${mention.type}: ${mention.path} (skipped: not a file)`
        );
        continue;
      }
      resolved.push({ path: relativeToWorktree || cleaned, type: mention.type });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") {
        annotationLines.push(
          `- ${mention.type}: ${mention.path} (skipped: not found)`
        );
        continue;
      }
      annotationLines.push(
        `- ${mention.type}: ${mention.path} (skipped: ${
          err instanceof Error ? err.message : String(err)
        })`
      );
    }
  }
  if (resolved.length === 0 && annotationLines.length === 0) {
    return { mentions: [], contextBlock: "", prefix: "" };
  }
  const header = [
    "<mentions>",
    "The user referenced the following paths in the active worktree. Each",
    "preview is a short snippet; the agent's file-reading tools can resolve",
    "the full file by joining the path with the worktree root.",
  ];
  const bodyLines = [
    ...resolved.map((mention) => `- ${mention.type}: ${mention.path}`),
    ...annotationLines,
  ];
  const contextBlock = [...header, ...bodyLines, "</mentions>"].join("\n");
  const previewLines: string[] = [];
  for (const mention of resolved) {
    if (mention.type === "file") {
      try {
        const absolutePath = path.resolve(worktreePath, mention.path);
        const handle = await fs.open(absolutePath, "r");
        try {
          const buffer = Buffer.alloc(MENTION_PREVIEW_BYTE_LIMIT);
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
          const raw = buffer.subarray(0, bytesRead).toString("utf-8");
          const lines = raw.split("\n").slice(0, MENTION_PREVIEW_LINE_LIMIT);
          const preview = lines.join("\n");
          previewLines.push(
            `--- ${mention.path} (first ${lines.length} line(s)) ---\n${preview}`
          );
        } finally {
          await handle.close();
        }
      } catch {
        // The agent can read the file itself; don't fail the turn.
      }
    } else {
      try {
        const absolutePath = path.resolve(worktreePath, mention.path);
        const dirents = await fs.readdir(absolutePath, { withFileTypes: true });
        const names = dirents
          .filter((entry) => entry.isDirectory() || entry.isFile())
          .map((entry) =>
            entry.isDirectory() ? `${entry.name}/` : entry.name
          )
          .slice(0, 200);
        previewLines.push(
          `--- ${mention.path}/ (${names.length} entries) ---\n${names.join("\n")}`
        );
      } catch {
        // As above, leave the block to the agent.
      }
    }
  }
  const prefix =
    previewLines.length === 0
      ? contextBlock
      : `${contextBlock}\n\n${previewLines.join("\n\n")}\n`;
  return { mentions: resolved, contextBlock, prefix };
}

/**
 * Parse the `mentions` query param shared by the SSE and headless
 * session-start routes. The wire format is `path|type,path|type,…`;
 * missing or unknown `type` values default to `file` so a hand-crafted
 * URL still parses. Malformed rows (empty path, non-string) are
 * dropped silently — the orchestrator is the source of truth, and a
 * bad row should not fail the whole turn.
 */
export function parseMentionsQuery(
  raw: string | string[] | undefined
): ResolvedMention[] {
  if (typeof raw !== "string" || !raw) return [];
  return raw
    .split(",")
    .map((entry) => {
      const [pathValue, typeValue] = entry.split("|");
      if (typeof pathValue !== "string" || !pathValue.trim()) return null;
      const type: "file" | "directory" =
        typeValue === "directory" ? "directory" : "file";
      return { path: pathValue.trim(), type };
    })
    .filter((value): value is ResolvedMention => value !== null);
}
