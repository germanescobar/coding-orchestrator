/*
 * Fuzzy matching for the in-memory file index used by
 * `FileFinderDialog` (issue #313).
 *
 * Scope: the entire client side of the file finder, the scoring
 * function, and the small in-memory index. The dialog itself lives in
 * `client/src/components/FileFinderDialog.tsx`.
 *
 * Matching strategy
 * -----------------
 * We use a tiny, dependency-free subsequence scorer: every char in
 * the query must appear in the candidate in order (case-insensitive).
 * A higher score rewards:
 *   - consecutive matches (`se` matches the start of `SessionView.tsx`
 *     over a `S…E` spread);
 *   - matches that land on path-separator boundaries (so `sv` finds
 *     `src/views/SessionView.tsx` faster than a generic `sv`
 *     anywhere in the string);
 *   - matches that hit the start of the basename;
 *   - shorter paths (when scores are otherwise equal).
 *
 * This is intentionally not fzf. We don't need to handle query
 * grammar (`^` / `$` / `!`), we just need a small, fast, predictable
 * scorer that returns a stable ordering for the dialog.
 */

export interface FileFinderEntry {
  /** Absolute path on disk, as the server returned it. */
  path: string;
  /** Path relative to the worktree root, used for display. */
  relativePath: string;
  /** File basename (e.g. `SessionView.tsx`). */
  name: string;
}

export interface FileFinderMatch {
  entry: FileFinderEntry;
  /** Higher is better. `-Infinity` is impossible (unmatched entries are filtered out). */
  score: number;
  /** Indices into `entry.relativePath` of every matched character, in order. */
  matchedIndices: number[];
}

/**
 * Run a fuzzy match over `entries`. `query` is matched
 * case-insensitively against `relativePath`. Returns the matches
 * ordered by score (desc) and then by relative path (asc) so the
 * ordering is stable for the dialog.
 *
 * If `query` is empty, every entry is returned with a score of `0`
 * and no highlighted indices; the dialog sorts those by
 * `relativePath` itself, which gives a stable "browse" mode.
 *
 * Recent-first boosting is the dialog's job — it interleaves the
 * `recent` list with the fuzzy results so the user sees their last
 * file even before they type anything.
 */
export function fuzzyMatchFiles(
  entries: FileFinderEntry[],
  query: string,
): FileFinderMatch[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) {
    return entries
      .map((entry) => ({ entry, score: 0, matchedIndices: [] as number[] }))
      .sort((a, b) => a.entry.relativePath.localeCompare(b.entry.relativePath));
  }

  const matches: FileFinderMatch[] = [];
  for (const entry of entries) {
    const result = scoreCandidate(entry.relativePath.toLowerCase(), normalized);
    if (!result) continue;
    matches.push({
      entry,
      score: result.score,
      matchedIndices: result.indices,
    });
  }

  matches.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.entry.relativePath.localeCompare(b.entry.relativePath);
  });
  return matches;
}

interface CandidateScore {
  score: number;
  indices: number[];
}

const SEPARATORS = new Set(["/", ".", "-", "_", " "]);

/**
 * Score `candidate` against `query`. Returns null when `query` is not
 * a subsequence of `candidate`.
 *
 * Scoring:
 *   - Each matched char adds 1.
 *   - Consecutive matches add a streak bonus that grows quadratically
 *     so a long run (e.g. matching the whole word) dominates a
 *     scattered match.
 *   - A match at position 0 (start of string) gets a small bonus.
 *   - A match right after a separator (path boundary) gets a bonus.
 *   - A match at the start of the basename gets a bonus.
 *   - The lowercased query is shorter than the candidate, so the
 *     final score is divided by the candidate length to penalise very
 *     long paths; this keeps the result stable across wide trees.
 */
function scoreCandidate(
  candidate: string,
  query: string,
): CandidateScore | null {
  const indices: number[] = [];
  let score = 0;
  let queryIndex = 0;
  let streak = 0;
  let lastIndex = -2; // sentinel so streak starts at 1 on a hit, not 2
  const basenameStart = candidate.lastIndexOf("/") + 1;
  const candidateLength = candidate.length;

  for (let i = 0; i < candidateLength && queryIndex < query.length; i++) {
    if (candidate[i] !== query[queryIndex]) continue;
    indices.push(i);
    let charScore = 1;
    streak = i === lastIndex + 1 ? streak + 1 : 1;
    if (streak > 1) charScore += streak * streak;
    if (i === 0) charScore += 5;
    if (i === basenameStart) charScore += 8;
    else if (i > 0 && SEPARATORS.has(candidate[i - 1])) charScore += 4;
    score += charScore;
    lastIndex = i;
    queryIndex++;
  }

  if (queryIndex < query.length) return null;
  // Normalise by candidate length so a hit inside a long path doesn't
  // always beat a hit inside a short one. Floor at 1 to avoid divide
  // by zero (not possible here, but cheap insurance).
  const lengthPenalty = Math.max(1, Math.log2(candidateLength + 1));
  return { score: score / lengthPenalty, indices };
}
