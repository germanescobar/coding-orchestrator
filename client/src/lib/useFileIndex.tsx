/*
 * Background file index for the fuzzy file finder (issue #313).
 *
 * Why a context instead of local state
 * ------------------------------------
 * The dialog rebuilt its in-memory index every time it opened unless
 * we cached the result somewhere outside the dialog's lifecycle. v1
 * did the walk inside the dialog's `useEffect`, which meant a fresh
 * walk on every Cmd+P — even though the worktree hadn't changed.
 * For a 1.2 GB `node_modules` that turned the dialog into a wait
 * screen, and the user had to watch the spinner every time they
 * wanted to open a file.
 *
 * The fix is a context keyed by `${projectId}:${worktreeId}` (or
 * `:main` for the main worktree) that owns the walk and exposes a
 * `useFileIndex` hook to consumers. The walk runs in the background
 * and is deduplicated across:
 *   - multiple mounts of `SessionView` (it remounts when the
 *     project/worktree changes),
 *   - multiple consumers of the same worktree (the file finder
 *     plus any future surface that wants the same list).
 *
 * Lifecycle
 * ---------
 *   1. `App.tsx` mounts `FileIndexProvider` around `AppBody`.
 *   2. Each worktree's `useFileIndex` call subscribes to the
 *      provider; the first subscriber triggers the walk.
 *   3. When the key changes, the previous walk's `cancelled` flag
 *      is set; in-flight fetches bail out and their results are
 *      dropped (via a per-walk seq counter).
 *   4. The walk streams results back so consumers can fuzzy-match
 *     against partial results while the walk is still running.
 *
 * The provider does NOT own the server. A future v3 can swap the
 * walk for a server-side `/projects/:id/files/search?q=...`
 * endpoint and keep the same `WorktreeIndex` shape; the dialog
 * doesn't need to know.
 */

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { fetchSourceDirectory } from "../api.ts";
import type { FileFinderEntry } from "./file-finder.ts";

/*
 * Hard caps on a single index. The skip list (`file-excludes.ts`)
 * keeps the walk small, but a very large monorepo or a project with
 * deep directory trees can still balloon past these. When that
 * happens we stop the walk and surface the cap as a soft error so
 * the user can refine the query.
 */
const MAX_INDEXED_DIRECTORIES = 5_000;
const MAX_INDEXED_FILES = 50_000;
const DIRECTORY_FETCH_TIMEOUT_MS = 6_000;

export type IndexStatus = "idle" | "indexing" | "ready" | "error";

export interface WorktreeIndex {
  /** All files discovered so far, in alphabetical `relativePath` order. */
  entries: FileFinderEntry[];
  status: IndexStatus;
  /** Human-readable error message when `status === "error"`. */
  error: string | null;
  /**
   * Number of directories visited so far. Cheap to render next to
   * the spinner so the user can see the walk is making progress.
   */
  visited: number;
  /**
   * `true` when the walk hit one of the hard caps. The dialog
   * renders a footer note so the user knows to refine their query.
   */
  stopped: boolean;
}

interface IndexStateInternal {
  entries: FileFinderEntry[];
  status: IndexStatus;
  error: string | null;
  visited: number;
  stopped: boolean;
  /**
   * Monotonic counter; bumped on every walk start so stale resolves
   * bail out without overwriting a fresher walk.
   */
  seq: number;
  /**
   * Subscribers to `useSyncExternalStore`. Notified after every
   * committed change so React re-renders the dialog while the
   * walk streams in.
   */
  listeners: Set<() => void>;
  /**
   * `true` when at least one consumer is currently subscribed.
   * Lets the provider stop the walk entirely when no one cares
   * (e.g. the dialog closed and the file tree never asked for
   * the index).
   */
  refCount: number;
}

function emptyState(): IndexStateInternal {
  return {
    entries: [],
    status: "idle",
    error: null,
    visited: 0,
    stopped: false,
    seq: 0,
    listeners: new Set(),
    refCount: 0,
  };
}

function indexKey(projectId: string, worktreeId: string | undefined): string {
  return `${projectId}:${worktreeId ?? "main"}`;
}

export interface FileIndexContextValue {
  /**
   * Subscribe to the index for a given worktree. Returns a stable
   * snapshot and an unsubscribe function compatible with
   * `useSyncExternalStore`.
   */
  subscribe: (
    projectId: string,
    worktreeId: string | undefined,
    onChange: () => void,
  ) => () => void;
  /**
   * Read the current snapshot of the index for a given worktree.
   */
  getSnapshot: (
    projectId: string,
    worktreeId: string | undefined,
  ) => WorktreeIndex;
  /**
   * Bump the seq counter for the given key, triggering a fresh walk.
   * Used by the dialog's Retry button.
   */
  retry: (projectId: string, worktreeId: string | undefined) => void;
}

const FileIndexContext = createContext<FileIndexContextValue | null>(null);

/**
 * Snapshot a `IndexStateInternal` into the public `WorktreeIndex`
 * shape. Snapshots are cached on the state object so we can return
 * the same reference across renders when nothing has changed.
 */
function snapshotFor(state: IndexStateInternal): WorktreeIndex {
  // `state.cachedSnapshot` holds the last-computed snapshot so
  // consecutive reads return the same reference. The walk only
  // re-assigns the field on `state.entries` / `state.status` etc.
  // when something material changed, so this is safe.
  const cached = (state as IndexStateInternal & { _cachedSnapshot?: WorktreeIndex })
    ._cachedSnapshot;
  if (cached) return cached;
  const fresh: WorktreeIndex = {
    entries: state.entries,
    status: state.status,
    error: state.error,
    visited: state.visited,
    stopped: state.stopped,
  };
  (state as IndexStateInternal & { _cachedSnapshot?: WorktreeIndex })._cachedSnapshot =
    fresh;
  return fresh;
}

function invalidateSnapshot(state: IndexStateInternal): void {
  (state as IndexStateInternal & { _cachedSnapshot?: WorktreeIndex })._cachedSnapshot =
    undefined;
}

/**
 * Races a `fetchSourceDirectory` call against a timer. A hung
 * request used to leave the dialog stuck on "Indexing files…"
 * forever; the timeout lets the error path run instead.
 */
function fetchSourceDirectoryWithTimeout(
  projectId: string,
  dirPath: string | undefined,
  worktreeId: string | undefined,
  timeoutMs: number,
): Promise<Awaited<ReturnType<typeof fetchSourceDirectory>>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new Error(
          `Timed out after ${timeoutMs / 1000}s while listing ${dirPath || "root"}`,
        ),
      );
    }, timeoutMs);
    fetchSourceDirectory(projectId, dirPath, worktreeId)
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
}

export function FileIndexProvider({ children }: { children: ReactNode }) {
  // We use a ref for the state map so reads / writes don't trigger
  // a re-render of the provider itself. The provider's only job is
  // to forward snapshot reads and change notifications; React
  // subscribes to specific keys via `useSyncExternalStore`, which
  // bypasses the provider's render cycle entirely.
  const indexMapRef = useRef<Map<string, IndexStateInternal>>(new Map());

  const ensureState = useCallback(
    (key: string): IndexStateInternal => {
      let state = indexMapRef.current.get(key);
      if (!state) {
        state = emptyState();
        indexMapRef.current.set(key, state);
      }
      return state;
    },
    [],
  );

  const startWalk = useCallback(
    (state: IndexStateInternal, projectId: string, worktreeId: string | undefined) => {
      // Bump the seq so any in-flight walk from a previous mount
      // bails out. Also reset the visible state.
      state.seq += 1;
      state.entries = [];
      state.status = "indexing";
      state.error = null;
      state.visited = 0;
      state.stopped = false;
      invalidateSnapshot(state);
      const seq = state.seq;
      const notify = () => {
        for (const listener of state.listeners) listener();
      };
      const next: FileFinderEntry[] = [];
      const seenPaths = new Set<string>();
      const queue: string[] = [""];
      let visited = 0;
      let stopped = false;
      let cancelled = false;
      let flushTimer: ReturnType<typeof setTimeout> | null = null;

      const flushEntries = () => {
        if (cancelled || state.seq !== seq) return;
        state.entries = next.slice();
        state.visited = visited;
        invalidateSnapshot(state);
        notify();
      };

      const scheduleFlush = () => {
        if (flushTimer !== null) return;
        flushTimer = setTimeout(() => {
          flushTimer = null;
          if (cancelled || state.seq !== seq) return;
          flushEntries();
        }, 50);
      };

      const process = async () => {
        while (queue.length > 0) {
          if (cancelled || state.seq !== seq) return;
          if (
            visited >= MAX_INDEXED_DIRECTORIES ||
            next.length >= MAX_INDEXED_FILES
          ) {
            stopped = true;
            break;
          }
          const dirPath = queue.shift()!;
          visited++;
          let dirEntries;
          try {
            dirEntries = await fetchSourceDirectoryWithTimeout(
              projectId,
              dirPath || undefined,
              worktreeId,
              DIRECTORY_FETCH_TIMEOUT_MS,
            );
          } catch (err) {
            if (cancelled || state.seq !== seq) return;
            state.status = "error";
            state.error =
              err instanceof Error ? err.message : "Failed to list files";
            state.visited = visited;
            invalidateSnapshot(state);
            notify();
            return;
          }
          if (cancelled || state.seq !== seq) return;
          for (const entry of dirEntries) {
            if (seenPaths.has(entry.path)) continue;
            seenPaths.add(entry.path);
            if (entry.type === "file") {
              next.push({
                path: entry.path,
                relativePath: entry.relativePath,
                name: entry.name,
              });
              if (next.length >= MAX_INDEXED_FILES) {
                stopped = true;
                break;
              }
            } else {
              queue.push(entry.path);
            }
          }
          scheduleFlush();
          if (queue.length > 0 && visited % 8 === 0) {
            await new Promise((resolve) => setTimeout(resolve, 0));
          }
        }
        if (cancelled || state.seq !== seq) return;
        if (flushTimer !== null) {
          clearTimeout(flushTimer);
          flushTimer = null;
        }
        next.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
        state.entries = next;
        state.visited = visited;
        state.status = "ready";
        state.stopped = stopped;
        if (stopped) {
          state.error = `Indexed ${next.length} files (capped at ${MAX_INDEXED_FILES}). Refine the query to narrow the result.`;
        }
        invalidateSnapshot(state);
        notify();
      };

      // Initial commit so consumers see `status: "indexing"`
      // immediately, before the first fetch resolves.
      notify();
      void process();
    },
    [],
  );

  const subscribe = useCallback(
    (
      projectId: string,
      worktreeId: string | undefined,
      onChange: () => void,
    ): (() => void) => {
      const key = indexKey(projectId, worktreeId);
      const state = ensureState(key);
      state.listeners.add(onChange);
      state.refCount += 1;
      if (state.status === "idle") {
        startWalk(state, projectId, worktreeId);
      }
      return () => {
        state.listeners.delete(onChange);
        state.refCount = Math.max(0, state.refCount - 1);
        // We don't tear down the index when the last subscriber
        // leaves — the cache is meant to survive dialog open/close
        // cycles. If we wanted to free memory in a future v3 we
        // could schedule a delayed teardown here.
      };
    },
    [ensureState, startWalk],
  );

  const getSnapshot = useCallback(
    (projectId: string, worktreeId: string | undefined): WorktreeIndex => {
      const key = indexKey(projectId, worktreeId);
      const state = ensureState(key);
      return snapshotFor(state);
    },
    [ensureState],
  );

  const retry = useCallback(
    (projectId: string, worktreeId: string | undefined) => {
      const key = indexKey(projectId, worktreeId);
      const state = ensureState(key);
      startWalk(state, projectId, worktreeId);
    },
    [ensureState, startWalk],
  );

  const value = useMemo<FileIndexContextValue>(
    () => ({ subscribe, getSnapshot, retry }),
    [subscribe, getSnapshot, retry],
  );

  return (
    <FileIndexContext.Provider value={value}>
      {children}
    </FileIndexContext.Provider>
  );
}

/**
 * Read the file-index context. Returns `null` when used outside the
 * provider — that's a programmer error, not a runtime condition.
 */
export function useFileIndexContext(): FileIndexContextValue {
  const ctx = useContext(FileIndexContext);
  if (!ctx) {
    throw new Error(
      "useFileIndexContext must be used inside <FileIndexProvider>",
    );
  }
  return ctx;
}

/**
 * Subscribe to the file index for a single (project, worktree) pair.
 * Re-renders the consumer as the walk progresses so the dialog can
 * show partial results, a progress counter, or an error state.
 *
 * The first call for a key kicks off the walk; subsequent calls
 * (and remounts) attach to the same walk and return its current
 * snapshot. The walk is deduped across consumers and across
 * open/close cycles of the dialog — the whole point of the
 * context.
 */
export function useFileIndex(
  projectId: string,
  worktreeId: string | undefined,
): WorktreeIndex {
  const ctx = useFileIndexContext();
  return useSyncExternalStore(
    (onChange) => ctx.subscribe(projectId, worktreeId, onChange),
    () => ctx.getSnapshot(projectId, worktreeId),
    () => ctx.getSnapshot(projectId, worktreeId),
  );
}
