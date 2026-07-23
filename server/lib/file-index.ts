/*
 * Recursive file/directory walk for the `@`-mention picker (issue #312).
 *
 * The single-level `/files` endpoint only lists entries in one directory,
 * so a user typing `@lib` would not see `client/src/lib/...` until they
 * expanded the right subtree. The picker needs a flat list of every
 * path the user could reasonably mention, scored by the fuzzy matcher
 * client-side.
 *
 * The walk is bounded: a depth cap keeps it from descending forever
 * (deeply-nested monorepos can reach hundreds of levels), a node cap
 * bounds the response size, and a denylist prunes directories that
 * should never be mentioned (`node_modules`, `.git`, build outputs).
 * Anything truncated returns a `truncated: true` flag so the picker can
 * show a hint instead of pretending the list is complete.
 *
 * Extracted from `server/routes/worktrees.ts` so the bounds and the
 * denylist are unit-testable in isolation, without an Express
 * harness.
 */
import fs from "node:fs/promises";
import path from "node:path";

export const MENTION_WALK_DEFAULT_DEPTH = 8;
export const MENTION_WALK_MAX_DEPTH = 32;
export const MENTION_WALK_DEFAULT_LIMIT = 2000;
export const MENTION_WALK_MAX_LIMIT = 20000;
export const MENTION_WALK_DENYLIST: ReadonlySet<string> = new Set([
  "node_modules",
  ".git",
  ".next",
  ".turbo",
  ".cache",
  "dist",
  "build",
  "out",
  "coverage",
  ".anita",
  ".coding-agent",
  ".coding-orchestrator",
]);

export interface FileIndexEntry {
  name: string;
  path: string;
  relativePath: string;
  type: "file" | "directory";
}

export interface FileIndexResult {
  root: string;
  depth: number;
  limit: number;
  truncated: boolean;
  entries: FileIndexEntry[];
}

/**
 * Walk `rootRealPath` up to `depth` levels deep, returning every
 * non-denylisted file and directory. BFS keeps the response short
 * (deep trees don't blow the stack) and the per-node cap bounds the
 * total work. The walk is best-effort: an unreadable directory is
 * skipped, never propagated as an error, so a single permission
 * hiccup doesn't blank the whole index.
 */
export async function buildFileIndex(
  rootRealPath: string,
  depth: number,
  limit: number
): Promise<FileIndexResult> {
  const entries: FileIndexEntry[] = [];
  let truncated = false;
  const queue: { absolute: string; depthLeft: number }[] = [
    { absolute: rootRealPath, depthLeft: depth },
  ];
  while (queue.length > 0) {
    if (entries.length >= limit) {
      truncated = true;
      break;
    }
    const current = queue.shift()!;
    let dirents: import("node:fs").Dirent[];
    try {
      dirents = await fs.readdir(current.absolute, { withFileTypes: true });
    } catch {
      // Unreadable directory (permissions, vanished mid-walk) — skip
      // rather than failing the whole index.
      continue;
    }
    for (const dirent of dirents) {
      if (entries.length >= limit) {
        truncated = true;
        break;
      }
      if (!dirent.isDirectory() && !dirent.isFile()) continue;
      const name = dirent.name as string;
      if (MENTION_WALK_DENYLIST.has(name)) continue;
      const entryAbsolute = path.join(current.absolute, name);
      const entryRelative = path.relative(rootRealPath, entryAbsolute);
      const type: "file" | "directory" = dirent.isDirectory()
        ? "directory"
        : "file";
      entries.push({
        name,
        path: entryAbsolute,
        relativePath: entryRelative,
        type,
      });
      if (dirent.isDirectory() && current.depthLeft > 0) {
        queue.push({
          absolute: entryAbsolute,
          depthLeft: current.depthLeft - 1,
        });
      }
    }
  }
  return { root: rootRealPath, depth, limit, truncated, entries };
}

export function clampInt(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number
): number {
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}
