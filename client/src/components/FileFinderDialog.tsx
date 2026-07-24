import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, ChevronRight, FileText, Loader2, Search } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog";
import { Kbd } from "@/components/ui/kbd";
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
import {
  useFileIndex,
  useFileIndexContext,
} from "../lib/useFileIndex.tsx";

/*
 * Fuzzy file finder dialog (issue #313).
 *
 * Mounts as a `Dialog` so the user can summon it from anywhere with
 * `cmd-p` (or whatever they've rebound `filesPanelSearch` to).
 *
 * The index itself lives in the app-level `FileIndexProvider`
 * (`client/src/lib/useFileIndex.tsx`) — a cache keyed by
 * `${projectId}:${worktreeId}` that owns the file walk. The dialog
 * is a pure consumer: it reads the current snapshot, fuzzy-matches
 * the user's query, and re-renders as the walk streams in partial
 * results. Re-opening the dialog is therefore instant — the
 * previous walk's results are still in the cache.
 *
 * Ranking:
 *   - Empty query: recently-opened files first (preserving order),
 *     then the alphabetical list, deduplicated by path.
 *   - Non-empty query: fuzzy match by relative path, capped at
 *     `RESULTS_LIMIT` to keep the list scrollable.
 *
 * Keyboard: `↑` / `↓` move the highlight, `Enter` opens the
 * highlighted file, `Esc` dismisses.
 */

const RESULTS_LIMIT = 200;

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
  const [highlightIndex, setHighlightIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  // Latest `onSelect` is kept in a ref so the result buttons don't
  // have to re-bind on every render.
  const onSelectRef = useRef(onSelect);
  useEffect(() => {
    onSelectRef.current = onSelect;
  }, [onSelect]);

  // Subscribe to the file index for the active worktree. The walk
  // starts the first time the provider sees a subscriber, so the
  // dialog doesn't need to do anything to kick it off.
  const index = useFileIndex(projectId, worktreeId);
  const { retry } = useFileIndexContext();

  // Reset the query and highlight when the dialog closes, so
  // re-opening starts from a clean state.
  useEffect(() => {
    if (open) return;
    setQuery("");
    setHighlightIndex(0);
  }, [open]);

  // Reset highlight whenever the result list shape changes (new
  // query, new entries arrived) so the keyboard selection always
  // lands on a visible row.
  useEffect(() => {
    setHighlightIndex(0);
  }, [query, index.entries.length, open]);

  const matches = useMemo<FileFinderMatch[]>(() => {
    if (index.entries.length === 0) return [];
    const fuzzy = fuzzyMatchFiles(index.entries, query);
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
  }, [index.entries, query, recent]);

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
    retry(projectId, worktreeId);
  }, [retry, projectId, worktreeId]);

  const hintChord = bindings?.filesPanelSearch ?? DEFAULT_SHORTCUT_BINDINGS.filesPanelSearch;
  const hintLabel = formatChord(hintChord, isMacPlatform());

  const showEmptyError = index.status === "error" && index.entries.length === 0;
  const showNoFiles =
    index.status !== "indexing" && index.status !== "error" && index.entries.length === 0;
  const showEmpty =
    index.status === "ready" && matches.length === 0 && index.entries.length > 0;
  const showResults = matches.length > 0;

  const footerHint = showEmptyError
    ? "Index failed"
    : index.status === "indexing"
    ? index.entries.length > 0
      ? `Indexing… ${index.entries.length} files so far`
      : "Indexing…"
    : showResults
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
              <p className="text-amber-200/80">{index.error ?? "Unknown error."}</p>
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
            matches.map((match, indexInList) => {
              const active = indexInList === highlightIndex;
              return (
                <button
                  key={match.entry.path}
                  ref={(node) => {
                    itemRefs.current[indexInList] = node;
                  }}
                  type="button"
                  onMouseEnter={() => setHighlightIndex(indexInList)}
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
        {index.error && index.status === "ready" ? (
          <div className="border-t border-amber-500/30 bg-amber-500/5 px-3 py-1.5 text-[10px] text-amber-200/80">
            {index.error}
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
            {index.status === "indexing" ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : null}
            {footerHint}
          </span>
        </div>
      </DialogContent>
    </Dialog>
  );
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
