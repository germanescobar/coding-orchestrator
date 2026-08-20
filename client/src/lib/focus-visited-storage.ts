/**
 * Persisted `visitedAt` storage for the focus queue.
 *
 * The visit timestamps that drive `sortFocusQueue`'s visited/unvisited
 * split live in App's React state, but they have to survive a reload
 * — otherwise every page refresh re-surfaces every pinned session as
 * "fresh," and pressing Next from any visited item walks forward
 * through the visited bucket instead of jumping to the top of remaining
 * unvisited. That's the regression the user's bug report (issue #333
 * follow-up) described after a reload.
 *
 * Storage layout: a single localStorage entry holding a JSON object
 * `{ [sessionId]: <ISO timestamp of last visit> }`. Entries older
 * than `VISITED_AT_TTL_MS` are dropped on load so a visit from last
 * week doesn't pin a session as "visited" this week.
 *
 * Storage failures (private-mode browsers, quota exceeded, malformed
 * JSON) fall back to an empty in-memory map and try to write through
 * on every change so the next successful write heals the state.
 *
 * Extracted from `App.tsx` so it can be unit-tested without a React
 * renderer — the helpers are pure functions over a `Storage`-shaped
 * object.
 */

export const VISITED_AT_STORAGE_KEY = "controller.focus.visitedAt";
export const VISITED_AT_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days.

export function loadSavedVisitedAt(storage: Pick<Storage, "getItem">): Record<string, string> {
  let raw: string | null = null;
  try {
    raw = storage.getItem(VISITED_AT_STORAGE_KEY);
  } catch {
    return {};
  }
  if (!raw) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object") return {};

  const cutoff = Date.now() - VISITED_AT_TTL_MS;
  const result: Record<string, string> = {};
  for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value !== "string") continue;
    const ts = Date.parse(value);
    if (Number.isNaN(ts)) continue;
    if (ts < cutoff) continue; // stale; treat as never-visited
    result[id] = value;
  }
  return result;
}

export function persistVisitedAt(
  storage: Pick<Storage, "setItem">,
  value: Record<string, string>,
): void {
  try {
    storage.setItem(VISITED_AT_STORAGE_KEY, JSON.stringify(value));
  } catch {
    // Quota exceeded, private mode, etc. — the in-memory state
    // still works for the rest of the session; the next successful
    // write will heal the on-disk state.
  }
}
