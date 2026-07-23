import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, ChevronRight, FileText, Loader2, Search } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog";
import { Kbd } from "@/components/ui/kbd";
import { fetchSourceDirectory } from "../api.ts";
import {
  fuzzyMatchFiles,
  type FileFinderEntry,
  type FileFinderMatch,
} from "../lib/file-finder.ts";
import { formatChord, isMacPlatform } from "../lib/shortcut-match.ts";
import {
  DEFAULT_SHORTCUT_BINDINGS,
  type ShortcutBindings,
} from "../../../shared/shortcuts.ts";

/*
 * Fuzzy file finder dialog (issue #313).
 *
 * Mounts as a top-level `<Dialog>` so the user can summon it from
 * anywhere with `cmd-p` (or whatever they've rebound `filesPanelSearch`
 * to). The dialog:
 *
 *   1. Lazily walks the active worktree via the existing
 *      `fetchSourceDirectory` route, building an in-memory index of
 *      every file path. The walk is bounded by hard caps on the
 *      number of visited directories and indexed files, and each
 *      directory fetch is wrapped in a per-call timeout so a hung
 *      request can't pin the spinner forever. The dialog also
 *      surfaces results as they arrive (no need to wait for the
 *      whole walk) so typing feels instant even for huge repos.
 *   2. Re-renders the index whenever `projectId` / `worktreeId`
 *      change so the dialog stays scoped to the active worktree.
 *   3. Ranks recently-opened files first (via the `recent` prop) and
 *      falls back to fuzzy matching on the path otherwise.
 *   4. Supports keyboard navigation: `↑` / `↓` move the highlight,
 *      `Enter` opens the highlighted file, `Esc` dismisses.
 *
 * Selecting a result calls `onSelect(path)` and then closes the
 * dialog. The host (`SessionView`) wires `onSelect` to the existing
 * `openSourcePath` so the file expands in the tree and shows up in
 * the preview.
 */

const MAX_INDEXED_DIRECTORIES = 5_000;
const MAX_INDEXED_FILES = 50_000;
const RESULTS_LIMIT = 200;
// Per-directory fetch timeout. A single hung request used to leave
// the dialog stuck on "Indexing files…" forever; 6 s is long enough
// to absorb a slow disk, short enough that a real outage fails
// fast.
const DIRECTORY_FETCH_TIMEOUT_MS = 6_000;

export interface FileFinderDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  worktreeId?: string;
  /**
   * Recently-opened file paths (most recent first), used to surface
   * the user's last few files at the top of the result list before
   * they type anything.
   */
  recent: string[];
  /**
   * Called when the user picks a file. The host typically wires this
   * to the existing `openSourcePath` so the file is opened in the
   * Files panel.
   */
  onSelect: (path: string) => void;
  /**
   * Effective shortcut bindings. `null` while the server fetch is in
   * flight; we fall back to the bundled defaults for the hint chip.
   */
  bindings: ShortcutBindings | null;
}

type IndexStatus = "idle" | "indexing" | "ready" | "error";

export function FileFinderDialog({
  open,
  onOpenChange,
  projectId,
  worktreeId,
  recent,
  onSelect,
  bindings,
}: FileFinderDialogProps) {
  const [query, setQuery] = useState("");
  const [entries, setEntries] = useState<FileFinderEntry[]>([]);
  // The indexer reports one of four states. `indexing` shows the
  // spinner, `error` shows a clear message + Retry button, `ready`
  // shows the results, and `idle` is the initial pre-fetch state.
  const [status, setStatus] = useState<IndexStatus>("idle");
  const [indexError, setIndexError] = useState<string | null>(null);
  const [highlightIndex, setHighlightIndex] = useState(0);
  // Bumped every time the user retries; the indexer's effect picks
  // it up to re-run from scratch.
  const [retryNonce, setRetryNonce] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  // Latest props are kept in refs so the index builder (which kicks
  // off async fetches and resolves later) always sees the active
  // `projectId` / `worktreeId` / `recent` list without re-running on
  // every render.
  const projectIdRef = useRef(projectId);
  const worktreeIdRef = useRef(worktreeId);
  const requestSeqRef = useRef(0);
  const onSelectRef = useRef(onSelect);

  useEffect(() => {
    projectIdRef.current = projectId;
    worktreeIdRef.current = worktreeId;
    onSelectRef.current = onSelect;
  }, [projectId, worktreeId, onSelect]);

  // Build / rebuild the in-memory index whenever the dialog opens,
  // the active worktree changes, or the user hits Retry. We reset
  // to an empty list and resequence requests so an in-flight stale
  // fetch can't overwrite a fresher one. Results are streamed into
  // `entries` as each directory returns, so the user can type and
  // see matches against whatever's been indexed so far instead of
  // waiting for the whole walk to finish.
  useEffect(() => {
    if (!open) {
      setQuery("");
      setHighlightIndex(0);
      return;
    }
    let cancelled = false;
    const seq = ++requestSeqRef.current;
    setStatus("indexing");
    setIndexError(null);
    setEntries([]);

    const projectIdCurrent = projectId;
    const worktreeIdCurrent = worktreeId;
    const next: FileFinderEntry[] = [];
    const seenPaths = new Set<string>();
    const queue: string[] = [""];
    let visited = 0;
    let stopped = false;
    let flushTimer: ReturnType<typeof setTimeout> | null = null;

    const flushEntries = () => {
      if (cancelled || seq !== requestSeqRef.current) return;
      // Snapshot a copy so React's setState can compare by reference
      // and we don't keep re-rendering on every individual entry.
      setEntries(next.slice());
    };

    const scheduleFlush = () => {
      if (flushTimer !== null) return;
      // Throttle UI updates to one render per animation frame so a
      // big tree doesn't drown the input field in renders.
      flushTimer = setTimeout(() => {
        flushTimer = null;
        flushEntries();
      }, 50);
    };

    const process = async () => {
      while (queue.length > 0) {
        if (cancelled) return;
        if (seq !== requestSeqRef.current) return;
        if (visited >= MAX_INDEXED_DIRECTORIES || next.length >= MAX_INDEXED_FILES) {
          stopped = true;
          break;
        }
        const dirPath = queue.shift()!;
        visited++;
        let dirEntries;
        try {
          dirEntries = await fetchSourceDirectoryWithTimeout(
            projectIdCurrent,
            dirPath || undefined,
            worktreeIdCurrent,
            DIRECTORY_FETCH_TIMEOUT_MS,
          );
        } catch (err) {
          // A single bad directory shouldn't poison the whole walk,
          // but a wrong worktree / missing server usually means every
          // fetch will fail with the same error. Surface the first
          // error verbatim, stop the walk, and show a Retry button.
          // The user can then fix the underlying cause (e.g. select
          // a valid worktree) and re-run.
          if (cancelled || seq !== requestSeqRef.current) return;
          setStatus("error");
          setIndexError(
            err instanceof Error ? err.message : "Failed to list files",
          );
          return;
        }
        if (cancelled || seq !== requestSeqRef.current) return;
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
        // Yield to the event loop between batches so a large repo
        // doesn't starve the input field's typing.
        if (queue.length > 0 && visited % 8 === 0) {
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
      }
      if (cancelled || seq !== requestSeqRef.current) return;
      if (flushTimer !== null) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      next.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
      setEntries(next);
      setStatus("ready");
      if (stopped) {
        setIndexError(
          `Indexed ${next.length} files (capped at ${MAX_INDEXED_FILES}). Refine the query to narrow the result.`,
        );
      }
    };

    void process();
    return () => {
      cancelled = true;
      if (flushTimer !== null) clearTimeout(flushTimer);
    };
  }, [open, projectId, worktreeId, retryNonce]);

  // Reset highlight whenever the result list shape changes so the
  // keyboard selection always lands on a visible row.
  useEffect(() => {
    setHighlightIndex(0);
  }, [query, entries.length, open]);

  const matches = useMemo<FileFinderMatch[]>(() => {
    if (entries.length === 0) return [];
    const fuzzy = fuzzyMatchFiles(entries, query);
    if (fuzzy.length === 0) return [];
    if (!query.trim()) {
      // Empty query: surface `recent` first (preserving order) then
      // the alphabetical list, deduplicated by path.
      const recentSet = new Set(recent);
      const byPath = new Map(fuzzy.map((m) => [m.entry.path, m]));
      const ordered: FileFinderMatch[] = [];
      for (const recentPath of recent) {
        const match = byPath.get(recentPath);
        if (match) ordered.push(match);
      }
      for (const match of fuzzy) {
        if (!recentSet.has(match.entry.path)) ordered.push(match);
      }
      return ordered.slice(0, RESULTS_LIMIT);
    }
    return fuzzy.slice(0, RESULTS_LIMIT);
  }, [entries, query, recent]);

  // Keep the highlighted row in view when the user navigates with
  // arrow keys.
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  useEffect(() => {
    const node = itemRefs.current[highlightIndex];
    if (node) node.scrollIntoView({ block: "nearest" });
  }, [highlightIndex]);

  const handleSelect = useCallback(
    (path: string) => {
      onSelectRef.current(path);
      onOpenChange(false);
    },
    [onOpenChange],
  );

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setHighlightIndex((current) =>
          matches.length === 0
            ? 0
            : (current + 1) % matches.length,
        );
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setHighlightIndex((current) =>
          matches.length === 0
            ? 0
            : (current - 1 + matches.length) % matches.length,
        );
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        const match = matches[highlightIndex];
        if (match) handleSelect(match.entry.path);
        return;
      }
    },
    [matches, highlightIndex, handleSelect],
  );

  const handleRetry = useCallback(() => {
    setRetryNonce((current) => current + 1);
  }, []);

  const hintChord = bindings?.filesPanelSearch ?? DEFAULT_SHORTCUT_BINDINGS.filesPanelSearch;
  const hintLabel = formatChord(hintChord, isMacPlatform());
  const indexing = status === "indexing";
  const showResults = status === "ready" || status === "indexing" || (status === "error" && entries.length > 0);
  const showEmptyError = status === "error" && entries.length === 0;
  const showEmpty = !indexing && !showEmptyError && matches.length === 0 && entries.length > 0;
  const showNoFiles = !indexing && !showEmptyError && entries.length === 0;
  const footerHint = showEmptyError
    ? "Index failed"
    : indexing
    ? entries.length > 0
      ? `Indexing… ${entries.length} files so far`
      : "Indexing…"
    : matches.length > 0
    ? `${matches.length}${matches.length === RESULTS_LIMIT ? "+" : ""} results`
    : "Type to search";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="sm:max-w-lg gap-0 p-0 overflow-hidden"
      >
        <DialogTitle className="sr-only">Find file</DialogTitle>
        <div className="flex h-10 items-center gap-2 border-b border-border px-3">
          <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <input
            ref={inputRef}
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Search files by path…"
            className="h-7 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            data-testid="file-finder-input"
          />
          <Kbd className="hidden sm:inline-flex">{hintLabel}</Kbd>
        </div>
        <div className="max-h-80 overflow-y-auto py-1" data-testid="file-finder-results">
          {showEmptyError ? (
            <div className="flex flex-col items-start gap-2 px-3 py-4 text-xs text-amber-200">
              <div className="flex items-center gap-2">
                <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                <span className="font-medium">Couldn&apos;t index files</span>
              </div>
              <p className="text-amber-200/80">{indexError ?? "Unknown error."}</p>
              <button
                type="button"
                onClick={handleRetry}
                className="rounded border border-amber-200/40 px-2 py-1 text-[11px] font-medium text-amber-100 transition-colors hover:bg-amber-200/10"
                data-testid="file-finder-retry"
              >
                Retry
              </button>
            </div>
          ) : showNoFiles ? (
            <div className="px-3 py-6 text-center text-xs text-muted-foreground">
              No files in this worktree.
            </div>
          ) : showEmpty ? (
            <div className="px-3 py-6 text-center text-xs text-muted-foreground">
              {`No matches for “${query}”.`}
            </div>
          ) : showResults ? (
            matches.map((match, index) => {
              const active = index === highlightIndex;
              return (
                <button
                  key={match.entry.path}
                  ref={(node) => {
                    itemRefs.current[index] = node;
                  }}
                  type="button"
                  onMouseEnter={() => setHighlightIndex(index)}
                  onClick={() => handleSelect(match.entry.path)}
                  className={`flex w-full min-w-0 items-center gap-2 px-3 py-1.5 text-left text-xs ${
                    active
                      ? "bg-accent/40 text-foreground"
                      : "text-muted-foreground hover:bg-muted/30"
                  }`}
                  data-testid="file-finder-result"
                  data-active={active ? "true" : "false"}
                >
                  <FileText className="h-3.5 w-3.5 shrink-0" />
                  <span className="min-w-0 flex-1 truncate font-mono">
                    {renderHighlighted(match)}
                  </span>
                  <ChevronRight className="h-3 w-3 shrink-0 opacity-60" />
                </button>
              );
            })
          ) : null}
        </div>
        {indexError && status === "ready" ? (
          <div className="border-t border-amber-500/30 bg-amber-500/5 px-3 py-1.5 text-[10px] text-amber-200/80">
            {indexError}
          </div>
        ) : null}
        <div className="flex items-center justify-between border-t border-border bg-muted/30 px-3 py-1.5 text-[10px] text-muted-foreground">
          <div className="flex items-center gap-2">
            <span className="flex items-center gap-1">
              <Kbd>↑</Kbd>
              <Kbd>↓</Kbd>
              navigate
            </span>
            <span className="flex items-center gap-1">
              <Kbd>Enter</Kbd>
              open
            </span>
            <span className="flex items-center gap-1">
              <Kbd>Esc</Kbd>
              close
            </span>
          </div>
          <span className="flex items-center gap-1.5 font-mono">
            {indexing ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
            {footerHint}
          </span>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Wraps `fetchSourceDirectory` with a per-call timeout. A hung
 * request used to leave the dialog stuck on "Indexing files…"
 * forever; this races the fetch against a timer and rejects if
 * either side wins, so the dialog's error path can run.
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

function renderHighlighted(match: FileFinderMatch): React.ReactNode {
  const { entry, matchedIndices } = match;
  if (matchedIndices.length === 0) {
    return entry.relativePath;
  }
  const indexed = new Set(matchedIndices);
  const parts: React.ReactNode[] = [];
  let buffer = "";
  let bufferIsMatch = false;
  for (let i = 0; i < entry.relativePath.length; i++) {
    const isMatch = indexed.has(i);
    if (parts.length === 0 || isMatch !== bufferIsMatch) {
      if (buffer) {
        parts.push(
          <span
            key={parts.length}
            className={bufferIsMatch ? "text-foreground font-medium" : undefined}
          >
            {buffer}
          </span>,
        );
      }
      buffer = entry.relativePath[i];
      bufferIsMatch = isMatch;
    } else {
      buffer += entry.relativePath[i];
    }
  }
  if (buffer) {
    parts.push(
      <span
        key={parts.length}
        className={bufferIsMatch ? "text-foreground font-medium" : undefined}
      >
        {buffer}
      </span>,
    );
  }
  return parts;
}
