import { getProjects, type Project } from "./projects.js";
import { getProjectWorktrees } from "./worktrees.js";
import { getSession } from "./sessions.js";

/*
 * Shared session locator (issue #339 review).
 *
 * The original wake / goal / monitor ID-only handlers (and the wakes
 * consumer in `wakes.ts`, and the goal-evaluator's `locateSession` dep)
 * each rolled their own "find which project owns a session" walk. Every
 * one of them stopped at `project.path` — the *main* worktree's path.
 * Sessions created in a non-main worktree live under
 * `projectStoreDir(worktree.path)`, so the original lookup returned
 * 404 (or null) for the majority of projects with more than one
 * worktree.
 *
 * This module is the single source of truth: enumerate every project,
 * enumerate every worktree, and try `getSession` against each
 * worktree path. The lookup cost is `O(projects × worktrees)` per
 * resolution — fine for the sizes we expect and identical to what a
 * future UI sidebar would do. Returning the worktree-id alongside the
 * project id lets callers route the queue advance through the
 * `resolveWorktree` plumbing instead of guessing the main worktree.
 */

export interface LocatedSession {
  session: NonNullable<Awaited<ReturnType<typeof getSession>>>;
  projectId: string;
  worktreeId: string;
  /** Absolute filesystem path of the worktree that owns the session. */
  worktreePath: string;
}

/**
 * Walk every project × worktree pair and return the first match for
 * `sessionId`. Returns `null` when the session id is unknown — the
 * session was archived + deleted, or never existed.
 */
export async function locateSessionById(
  sessionId: string
): Promise<LocatedSession | null> {
  const projects = await getProjects();
  for (const project of projects) {
    const located = await locateSessionInProject(project, sessionId);
    if (located) return located;
  }
  return null;
}

/**
 * Path-only variant for the wakes consumer (issue #339 review). The
 * consumer only needs the project id + worktree path to fire the
 * queue advance; re-reading the full session state would be wasted
 * I/O on every scheduler tick.
 *
 * Implemented as a `getSession`-based walk so it shares the canonical
 * `projectStoreDir` resolution with the rest of the codebase — no
 * hand-rolled `path.resolve` math that could drift out of sync. The
 * cost is one `getSession` parse per worktree (the JSON file is
 * small), and the wakes consumer calls this exactly once per
 * session id per tick.
 */
export interface LocatedSessionPath {
  projectId: string;
  worktreeId: string;
  worktreePath: string;
}

export async function locateSessionPath(
  sessionId: string
): Promise<LocatedSessionPath | null> {
  const located = await locateSessionById(sessionId);
  if (!located) return null;
  return {
    projectId: located.projectId,
    worktreeId: located.worktreeId,
    worktreePath: located.worktreePath,
  };
}

/**
 * Look up a session within one project by enumerating that project's
 * worktrees (main + non-main). Sessions whose `worktreeId` doesn't
 * match a known worktree also fall back to the main path — legacy
 * resumed sessions or projects with a deleted worktree still resolve.
 */
async function locateSessionInProject(
  project: Project,
  sessionId: string
): Promise<LocatedSession | null> {
  // First try the main worktree — most legacy sessions live there.
  const mainCandidate = await getSession(project.path, sessionId);
  if (mainCandidate) {
    return {
      session: mainCandidate,
      projectId: project.id,
      worktreeId: mainCandidate.worktreeId ?? "",
      worktreePath: project.path,
    };
  }
  // Fall through to non-main worktrees via the registered registry.
  const worktrees = await getProjectWorktrees(project.id).catch(() => []);
  for (const worktree of worktrees) {
    if (worktree.path === project.path) continue; // already tried main
    const candidate = await getSession(worktree.path, sessionId);
    if (candidate) {
      return {
        session: candidate,
        projectId: project.id,
        worktreeId: candidate.worktreeId ?? worktree.id,
        worktreePath: worktree.path,
      };
    }
  }
  return null;
}