import fs from "node:fs/promises";
import { sessionGoalFile, sessionGoalsDir } from "./paths.js";

/*
 * Controller-owned goal state for a session (issue #339).
 *
 * A goal is a user- or agent-supplied completion condition paired with a
 * cap (`maxTurns` and/or `expiresAt`). After every turn the
 * `GoalEvaluator` consumer (registered on the shared wakeup loop from
 * #243) reads the goal + the session's recent transcript, asks a small
 * model whether the condition is met, and either clears the goal (met)
 * or enqueues a follow-up turn on the agent's behalf (not met + empty
 * queue). The shape mirrors `SessionFocus`: lives in a Controller-owned
 * sidecar under `<controllerHome>/goals/<sessionId>.json` so the
 * provider never sees or overwrites it.
 */

export interface SessionGoal {
  sessionId: string;
  condition: string;
  /** Cap on the number of turns the evaluator will judge before clearing. */
  maxTurns?: number;
  /** ISO timestamp; after this the evaluator clears the goal. */
  expiresAt?: string;
  /** ISO timestamp when the goal was set. */
  setAt: string;
  /** How many turns the evaluator has judged so far. */
  turnsEvaluated: number;
  /** Reason string from the evaluator's last call (for debugging). */
  lastReason?: string;
  /** Updated at the end of every successful evaluator write. */
  updatedAt: string;
}

/**
 * Read the goal for a session. Returns `null` when no sidecar exists
 * (the default — a session has no goal until one is attached).
 */
export async function readSessionGoal(
  sessionId: string
): Promise<SessionGoal | null> {
  try {
    const content = await fs.readFile(sessionGoalFile(sessionId), "utf-8");
    const parsed = JSON.parse(content) as Partial<SessionGoal>;
    if (
      typeof parsed.condition === "string" &&
      typeof parsed.setAt === "string"
    ) {
      return parsed as SessionGoal;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Persist a goal for a session. Pass `null` (with `sessionId` separately)
 * to clear the goal entirely. The goal sidecar lives under
 * `<controllerHome>/goals/`, separate from the focus sidecar, so the two
 * never collide on disk. `updatedAt` is only refreshed when the caller
 * didn't supply one — `buildSessionGoal` stamps both `setAt` and
 * `updatedAt` at the same instant, and we want round-trips through
 * `readSessionGoal` → `writeSessionGoal` to be byte-stable so deep-equal
 * tests don't drift on millisecond rounding.
 */
export async function writeSessionGoal(
  goal: SessionGoal | null,
  clearSessionId?: string
): Promise<void> {
  await fs.mkdir(sessionGoalsDir(), { recursive: true });
  if (!goal) {
    if (!clearSessionId) {
      throw new Error("writeSessionGoal requires clearSessionId when goal is null");
    }
    // Best-effort delete; ignore ENOENT (no goal to clear).
    try {
      await fs.unlink(sessionGoalFile(clearSessionId));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return;
  }
  const stamped: SessionGoal = {
    ...goal,
    updatedAt: goal.updatedAt ?? new Date().toISOString(),
  };
  await fs.writeFile(
    sessionGoalFile(goal.sessionId),
    JSON.stringify(stamped, null, 2)
  );
}

/**
 * Build a fresh `SessionGoal` record from the caller-supplied condition
 * and optional caps. Centralizes `sessionId` / `setAt` stamping so route
 * handlers don't have to remember it.
 */
export function buildSessionGoal(
  sessionId: string,
  fields: {
    condition: string;
    maxTurns?: number;
    expiresAt?: string;
  }
): SessionGoal {
  if (!fields.condition || !fields.condition.trim()) {
    throw new Error("goal condition must not be empty");
  }
  if (fields.maxTurns != null) {
    if (!Number.isInteger(fields.maxTurns) || fields.maxTurns <= 0) {
      throw new Error("goal maxTurns must be a positive integer");
    }
  }
  if (fields.expiresAt != null) {
    const parsed = new Date(fields.expiresAt);
    if (Number.isNaN(parsed.getTime())) {
      throw new Error(`Invalid goal expiresAt "${fields.expiresAt}"`);
    }
  }
  const now = new Date().toISOString();
  const goal: SessionGoal = {
    sessionId,
    condition: fields.condition.trim(),
    setAt: now,
    turnsEvaluated: 0,
    updatedAt: now,
  };
  if (fields.maxTurns != null) goal.maxTurns = fields.maxTurns;
  if (fields.expiresAt != null) goal.expiresAt = fields.expiresAt;
  return goal;
}

/** Clear any goal attached to `sessionId`. Idempotent. */
export async function clearSessionGoal(sessionId: string): Promise<void> {
  return writeSessionGoal(null, sessionId);
}