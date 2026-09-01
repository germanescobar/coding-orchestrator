import fs from "node:fs/promises";
import path from "node:path";
import {
  clearSessionGoal,
  readSessionGoal,
  writeSessionGoal,
  type SessionGoal,
} from "./goal-state.js";
import { getApiKeyEnvVars } from "./api-keys.js";
import { projectStoreDir } from "./paths.js";
import { listQueue, enqueue as enqueueMessage } from "./session-queue.js";
import {
  getEvents,
  appendEvent,
  type AgentEvent,
} from "./sessions.js";

/*
 * Goal evaluator (issue #339).
 *
 * The GoalEvaluator is the third wheel of the same-session, condition-
 * driven loop alongside `wake --delay` and the run-completion queue
 * drain. After every `run.completed` for a session with a goal, the
 * shared wakeup loop (issue #243) hands the session to this evaluator;
 * it reads the goal + the session's recent events, asks a small fast
 * model whether the condition is met, and either:
 *
 *   1. clears the goal (met, or cap exceeded), emitting `goal.cleared`;
 *   2. leaves the goal alone (the agent has already enqueued a follow-up
 *      that the queue pipeline will drain);
 *   3. enqueues a short follow-up on the agent's behalf when the
 *      condition isn't met AND the queue is empty — the safety net that
 *      distinguishes `/goal` from `/loop` (a sloppy agent can't decide
 *      the work is done by ending the turn quietly).
 *
 * The model is intentionally haiku-class: this is a cheap judgment on
 * a transcript excerpt, not the agent's actual work.
 */

const TRANSCRIPT_TAIL_EVENTS = 50;
/** Default follow-up prompt the evaluator enqueues when the goal isn't met. */
const DEFAULT_FOLLOW_UP_PROMPT =
  "Continue working toward the active goal. Re-read the goal condition and the latest transcript, take the next concrete step, and either re-set the goal if you have more work to do or call `controller sessions goal clear` if the condition is satisfied.";
const DEFAULT_MODEL = "anthropic/claude-3-haiku";
/** OpenRouter chat-completions endpoint; the orchestrator's providers
 *  include OpenRouter, so reusing it keeps the evaluator on a key the
 *  user has already configured. */
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

export interface EvaluatorOutcome {
  /** Resulting goal state after this evaluation pass. */
  goal: SessionGoal | null;
  /** Whether the evaluator enqueued a follow-up turn. */
  enqueued: boolean;
  /** Reason string the evaluator recorded. */
  reason: string;
}

export interface GoalEvaluatorDeps {
  /** Returns the project id for a session id (the consumer-side lookup). */
  locateSession: (sessionId: string) => Promise<{
    projectId: string;
    worktreeId: string;
    worktreePath: string;
  } | null>;
  /** Wall-clock injection for tests. */
  now?: () => Date;
  /** API key lookup; defaults to the orchestrator's provider keys. */
  getApiKey?: () => Promise<Record<string, string>>;
  /** Override the model id (defaults to a haiku-class OpenRouter model). */
  model?: string;
  /** Override the follow-up prompt the evaluator enqueues. */
  followUpPrompt?: string;
  /** Inject the chat-completions call for tests. */
  callModel?: (params: {
    model: string;
    system: string;
    user: string;
    apiKey: string;
  }) => Promise<{ met: boolean; reason: string }>;
}

interface GoalEvalResult {
  met: boolean;
  reason: string;
}

/**
 * Evaluate one session's goal. Returns the resulting goal state plus a
 * flag for whether the evaluator enqueued a follow-up. The caller is
 * responsible for registering the evaluator on the shared wakeup loop
 * (see `makeGoalEvaluatorConsumer`) and for not invoking this for
 * sessions that are mid-turn — the consumer checks runtime state.
 */
export async function evaluateGoal(
  sessionId: string,
  deps: GoalEvaluatorDeps
): Promise<EvaluatorOutcome> {
  const goal = await readSessionGoal(sessionId);
  if (!goal) {
    return { goal: null, enqueued: false, reason: "no goal attached" };
  }

  const now = (deps.now ?? (() => new Date()))();
  // Cap checks first: an expired goal clears without a model call. The
  // evaluator's whole point is to be cheap, so we skip the LLM hop
  // whenever the cap forces a clear.
  if (goal.expiresAt && new Date(goal.expiresAt).getTime() <= now.getTime()) {
    await clearSessionGoal(sessionId);
    await emitCleared(sessionId, "expired", deps);
    return { goal: null, enqueued: false, reason: "expired" };
  }
  if (goal.maxTurns != null && goal.turnsEvaluated >= goal.maxTurns) {
    await clearSessionGoal(sessionId);
    await emitCleared(sessionId, "exceeded", deps);
    return { goal: null, enqueued: false, reason: "exceeded" };
  }

  // Otherwise ask the small model. A throw or a malformed response leaves
  // the goal in place (a transient failure shouldn't kill the loop), but
  // we surface the failure via `reason` so the user sees why the
  // evaluator didn't progress.
  let result: GoalEvalResult;
  try {
    result = await judgeCondition(goal, sessionId, deps);
  } catch (error) {
    const reason = `judge failed: ${
      error instanceof Error ? error.message : String(error)
    }`;
    await stampReason(sessionId, reason);
    return { goal: { ...goal, lastReason: reason }, enqueued: false, reason };
  }

  const updated: SessionGoal = {
    ...goal,
    turnsEvaluated: goal.turnsEvaluated + 1,
    lastReason: result.reason,
  };
  await writeSessionGoal(updated);

  if (result.met) {
    await clearSessionGoal(sessionId);
    await emitCleared(sessionId, "met", deps);
    return { goal: null, enqueued: false, reason: result.reason };
  }

  // Not met: if the agent has already enqueued a follow-up, the queue
  // pipeline drains it naturally — we leave the goal in place and
  // exit. If the queue is empty, the evaluator enqueues a short prompt
  // so the loop continues without requiring the agent to remember to
  // re-fire. The cap above still bounds this.
  const located = await deps.locateSession(sessionId).catch(() => null);
  if (!located) {
    return { goal: updated, enqueued: false, reason: result.reason };
  }
  const queue = await listQueue(sessionId).catch(() => []);
  if (queue.length > 0) {
    // The agent has already queued a follow-up; nothing to do.
    return { goal: updated, enqueued: false, reason: result.reason };
  }
  const prompt = deps.followUpPrompt ?? DEFAULT_FOLLOW_UP_PROMPT;
  await enqueueMessage(sessionId, {
    text: prompt,
    visibleText: prompt,
    provider: "claude",
    model: "claude/test",
    mode: "default",
    attachmentIds: [],
  });
  return { goal: updated, enqueued: true, reason: result.reason };
}

async function stampReason(sessionId: string, reason: string): Promise<void> {
  const existing = await readSessionGoal(sessionId);
  if (!existing) return;
  await writeSessionGoal({ ...existing, lastReason: reason });
}

async function emitCleared(
  sessionId: string,
  reason: string,
  deps: GoalEvaluatorDeps
): Promise<void> {
  const located = await deps.locateSession(sessionId).catch(() => null);
  if (!located) return;
  const event: AgentEvent = {
    id: cryptoRandomId(),
    sessionId,
    timestamp: new Date().toISOString(),
    type: "goal_cleared",
    data: { reason },
  };
  try {
    await appendEvent(located.worktreePath, sessionId, event);
  } catch {
    // Best-effort: the goal file is the source of truth, the event log
    // is for the UI. A failed write doesn't undo the clear.
  }
}

function cryptoRandomId(): string {
  // Avoid pulling `node:crypto` at module load; use Web Crypto when
  // available, fall back to Math.random for environments without it
  // (the goal id only needs to be unique within one event log file).
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/**
 * Call the small model and parse a `{ met, reason }` answer. The prompt
 * is short by design: the agent's transcript is the heavy context, and
 * the judge only needs the condition + the recent tail.
 */
async function judgeCondition(
  goal: SessionGoal,
  sessionId: string,
  deps: GoalEvaluatorDeps
): Promise<GoalEvalResult> {
  const apiKeys = await (deps.getApiKey ?? getApiKeyEnvVars)();
  const apiKey = apiKeys.openrouter ?? apiKeys.OPENROUTER_API_KEY;
  if (!apiKey) {
    // No key configured — fail soft so the goal doesn't get stuck. The
    // session stays alive (the cap still bounds the loop); the user sees
    // a `lastReason` they can act on.
    throw new Error(
      "OpenRouter API key not configured (set it in the API keys surface for the evaluator to run)"
    );
  }

  const tail = await readTranscriptTail(sessionId, deps).catch(() => []);
  const transcript = tail
    .map((event) => formatEventForJudge(event))
    .filter(Boolean)
    .join("\n");

  const system = [
    "You are a goal-completion judge for a coding-agent session.",
    "Given a completion condition and the agent's recent transcript,",
    "decide whether the condition is now satisfied.",
    "Respond with a single JSON object: {\"met\": boolean, \"reason\": string}.",
    "The reason must be one short sentence a human can read.",
    "Do not run any tools. Do not produce anything other than the JSON object.",
  ].join(" ");

  const user = [
    `CONDITION: ${goal.condition}`,
    "",
    "RECENT TRANSCRIPT:",
    transcript || "(empty)",
  ].join("\n");

  const call = deps.callModel ?? defaultCallModel;
  return call({
    model: deps.model ?? DEFAULT_MODEL,
    system,
    user,
    apiKey,
  });
}

/**
 * Read the last `TRANSCRIPT_TAIL_EVENTS` events for the session. The
 * events file is JSONL so this is a tail-read with line skipping; we
 * keep the in-memory cost bounded so a long-lived session doesn't
 * balloon the judge's prompt.
 */
async function readTranscriptTail(
  sessionId: string,
  deps: GoalEvaluatorDeps
): Promise<AgentEvent[]> {
  const located = await deps.locateSession(sessionId).catch(() => null);
  if (!located) return [];
  const events = await getEvents(located.worktreePath, sessionId);
  if (events.length <= TRANSCRIPT_TAIL_EVENTS) return events;
  return events.slice(events.length - TRANSCRIPT_TAIL_EVENTS);
}

function formatEventForJudge(event: AgentEvent): string {
  const data = event.data ?? {};
  switch (event.type) {
    case "assistant_response":
      return typeof data.text === "string"
        ? `assistant: ${truncate(data.text, 400)}`
        : "";
    case "tool_call":
      return `tool_call(${String(data.name ?? "unknown")})`;
    case "tool_result":
      return `tool_result(${truncate(asString(data.result), 200)})`;
    case "user_message":
      return typeof data.text === "string"
        ? `user: ${truncate(data.text, 200)}`
        : "";
    case "goal_cleared":
      return `goal_cleared(${String(data.reason ?? "")})`;
    case "error":
      return `error(${truncate(asString(data.text), 200)})`;
    default:
      return "";
  }
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}…`;
}

/**
 * Default chat-completions caller. Hits OpenRouter (one HTTP POST) with
 * the model the evaluator was configured with. We force
 * `response_format: { type: "json_object" }` so the response is a
 * parseable JSON object, and fall back to a permissive regex parse when
 * the provider ignores the hint.
 */
async function defaultCallModel(params: {
  model: string;
  system: string;
  user: string;
  apiKey: string;
}): Promise<GoalEvalResult> {
  const response = await fetch(OPENROUTER_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${params.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: params.model,
      messages: [
        { role: "system", content: params.system },
        { role: "user", content: params.user },
      ],
      response_format: { type: "json_object" },
      temperature: 0,
    }),
  });
  if (!response.ok) {
    throw new Error(`OpenRouter HTTP ${response.status}`);
  }
  const body = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = body.choices?.[0]?.message?.content ?? "";
  return parseJudgeResponse(content);
}

/**
 * Parse the judge's response. OpenRouter with `response_format:
 * json_object` returns a JSON string the model produced; we accept
 * either strict JSON or a single-line JSON object embedded in text.
 */
export function parseJudgeResponse(raw: string): GoalEvalResult {
  const trimmed = raw.trim();
  // Direct parse first.
  try {
    const parsed = JSON.parse(trimmed) as { met?: unknown; reason?: unknown };
    if (typeof parsed.met === "boolean") {
      return {
        met: parsed.met,
        reason:
          typeof parsed.reason === "string" && parsed.reason.trim()
            ? parsed.reason
            : parsed.met
              ? "condition met"
              : "condition not met",
      };
    }
  } catch {
    // Fall through to a regex extraction for providers that ignore
    // `response_format`.
  }
  const match = /\{[\s\S]*?"met"\s*:\s*(true|false)[\s\S]*?\}/.exec(trimmed);
  if (match) {
    try {
      const parsed = JSON.parse(match[0]) as { met: boolean; reason?: string };
      return {
        met: parsed.met,
        reason: parsed.reason ?? (parsed.met ? "met" : "not met"),
      };
    } catch {
      // Fall through to the default.
    }
  }
  // Default to "not met" so the loop continues — a malformed response
  // must never accidentally clear the goal.
  return { met: false, reason: "judge response could not be parsed" };
}

/**
 * Build a tick consumer (issue #339). The returned function is
 * synchronous and detaches its work via `fireAndForget` so a slow
 * evaluator on one session cannot block the next tick.
 */
export function makeGoalEvaluatorConsumer(
  deps: GoalEvaluatorDeps,
  fireAndForget: (work: Promise<unknown>) => void,
  listCandidateSessions: () => Promise<string[]>
): (now: Date) => void {
  return (now: Date) => {
    fireAndForget(runGoalEvaluatorSweep(listCandidateSessions(), deps));
  };
}

/**
 * Sweep every session with a goal. Exported for tests. Failures on
 * individual sessions do not abort the sweep.
 */
export async function runGoalEvaluatorSweep(
  candidateSessions: Promise<string[]> | string[],
  deps: GoalEvaluatorDeps
): Promise<void> {
  const sessions = await candidateSessions;
  await Promise.all(
    sessions.map(async (sessionId) => {
      try {
        await evaluateGoal(sessionId, deps);
      } catch (error) {
        console.error(
          `[goal-evaluator] failed for ${sessionId}:`,
          error instanceof Error ? error.message : error
        );
      }
    })
  );
}

/**
 * List every session id that currently has a goal sidecar. Used by the
 * consumer to enumerate the work for a tick. Iterates the goals
 * directory directly so the evaluator is decoupled from project state
 * (e.g. a session whose project is archived is still reachable for
 * evaluation until the goal clears on its own). The shape check (a
 * candidate must look like `{ condition, setAt }`) filters out files
 * that share the directory but aren't goals, so a malformed sidecar
 * can't crash the sweep.
 */
export async function listGoalSessions(): Promise<string[]> {
  const dir = path.join(projectStoreDir("."), "..", "..", "goals");
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }
  const candidates = entries
    .filter((file) => file.endsWith(".json"))
    .map((file) => file.slice(0, -".json".length));
  const valid: string[] = [];
  await Promise.all(
    candidates.map(async (sessionId) => {
      try {
        const content = await fs.readFile(
          path.join(dir, `${sessionId}.json`),
          "utf-8"
        );
        const parsed = JSON.parse(content) as { condition?: unknown; setAt?: unknown };
        if (typeof parsed.condition === "string" && typeof parsed.setAt === "string") {
          valid.push(sessionId);
        }
      } catch {
        // Skip malformed files — one bad sidecar must never crash the
        // sweep. Matches the focus-state listSessions behavior.
      }
    })
  );
  return valid;
}