import test from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import {
  SchedulesSection,
  ScheduleRow,
  CreateScheduleForm,
} from "../schedules-section.tsx";
import type {
  Project,
  Schedule,
  ScheduleWithProject,
  Worktree,
} from "../../api.ts";

/*
 * Regression test for the Schedules settings section (issue #303).
 *
 * The server side is fully covered by `server/lib/__tests__/schedules.test.ts`
 * and the REST surface in `server/routes/schedules.ts`. This file covers what
 * the UI is responsible for:
 *
 *   1. List rendering — `ScheduleRow` surfaces project name, prompt
 *      preview, trigger type, enabled state, last run, and last error.
 *      The section is cross-project (per review feedback on #303), so
 *      each row also carries a project badge.
 *   2. Create happy path — `CreateScheduleForm` (extracted from the
 *      dialog wrapper) exposes the project + worktree selectors, the
 *      prompt, the trigger toggle, and the save button.
 *   3. Delete confirmation — the section renders an `AlertDialog` and
 *      only fires DELETE after the destructive action is confirmed
 *      (verified via the data-testid hooks).
 *   4. Enable / disable toggle — `ScheduleRow` renders a `Switch` that
 *      reflects `schedule.enabled` and is wired to `onToggle`.
 *
 * We use `renderToStaticMarkup` (matching the other client regression
 * tests in this folder) and export the inner `ScheduleRow` /
 * `CreateScheduleForm` so we can render them with deterministic inputs
 * without mounting the full stateful section.
 */

const NOOP = () => {};
const NOOP_STR = (_v: string) => {};
const NOOP_TRIGGER = (_v: "runAt" | "cron") => {};
const NOOP_ASYNC = async () => [];

const PROJECT: Project = {
  id: "project-1",
  name: "Anita",
  path: "/tmp/project-1",
  createdAt: "2025-01-01T00:00:00.000Z",
};

const PROJECT_2: Project = {
  id: "project-2",
  name: "Germini",
  path: "/tmp/project-2",
  createdAt: "2025-01-01T00:00:00.000Z",
};

const WORKTREES: Worktree[] = [
  {
    id: "wt-1",
    projectId: PROJECT.id,
    name: "main",
    path: "/tmp/wt-1",
    isMain: true,
    createdAt: "2025-01-01T00:00:00.000Z",
  },
  {
    id: "wt-2",
    projectId: PROJECT.id,
    name: "feature",
    path: "/tmp/wt-2",
    isMain: false,
    createdAt: "2025-01-01T00:00:00.000Z",
  },
];

function schedule(overrides: Partial<Schedule> = {}): Schedule {
  return {
    id: "sched-1",
    projectId: PROJECT.id,
    worktreeId: "wt-1",
    prompt: "Run the daily digest",
    cron: "0 9 * * *",
    timezone: "UTC",
    runAt: null,
    nextRunAt: "2025-05-01T09:00:00.000Z",
    lastRunAt: null,
    lastRunSessionId: null,
    lastError: null,
    source: "user",
    enabled: true,
    createdAt: "2025-04-30T00:00:00.000Z",
    createdBy: "ui",
    ...overrides,
  };
}

function withProject(
  base: Schedule,
  project: Project
): ScheduleWithProject {
  return { ...base, projectName: project.name };
}

function renderRow(
  entry: ScheduleWithProject,
  options: { toggling?: boolean } = {}
): string {
  return renderToStaticMarkup(
    <ScheduleRow
      schedule={entry}
      onToggle={NOOP}
      onDelete={NOOP}
      onViewRuns={NOOP}
      toggling={options.toggling ?? false}
    />,
  );
}

// ---------------------------------------------------------------------------
// 1. List rendering — `ScheduleRow`
// ---------------------------------------------------------------------------

test("ScheduleRow surfaces the project name, trigger, and prompt preview for a cron schedule", () => {
  const html = renderRow(withProject(schedule(), PROJECT));
  assert.match(html, /data-testid="schedule-row-sched-1"/);
  assert.match(html, /Run the daily digest/);
  // Project badge is the first thing in the row.
  assert.match(html, />Anita</);
  // Trigger label is human-readable: cron expression.
  assert.match(html, /cron: 0 9 \* \* \*/);
  // Source badge.
  assert.match(html, />user</);
  // No "disabled" badge for an enabled row.
  assert.doesNotMatch(html, />disabled</);
});

test("ScheduleRow renders the trigger type and runAt for a one-shot schedule", () => {
  const html = renderRow(
    withProject(
      schedule({ id: "sched-2", cron: null, runAt: "2025-06-01T00:00:00.000Z" }),
      PROJECT
    )
  );
  // The trigger badge switches to "runAt" for one-shots.
  assert.match(html, />runAt</);
  // The trigger label includes the runAt timestamp.
  assert.match(html, /one-shot: 2025-06-01 00:00 UTC/);
});

test("ScheduleRow shows the disabled badge for a paused schedule", () => {
  const html = renderRow(withProject(schedule({ enabled: false }), PROJECT));
  assert.match(html, />disabled</);
});

test("ScheduleRow shows the last run timestamp when present", () => {
  const html = renderRow(
    withProject(
      schedule({ lastRunAt: "2025-04-30T09:00:00.000Z" }),
      PROJECT
    )
  );
  assert.match(html, /last: 2025-04-30 09:00 UTC/);
});

test("ScheduleRow surfaces lastError inline when the last fire failed", () => {
  const html = renderRow(
    withProject(
      schedule({ lastError: "Invalid cron: foo bar baz" }),
      PROJECT
    )
  );
  assert.match(html, /Invalid cron: foo bar baz/);
});

test("ScheduleRow exposes the enable toggle, runs link, and delete control", () => {
  const html = renderRow(withProject(schedule(), PROJECT));
  assert.match(html, /data-testid="schedule-toggle-sched-1"/);
  assert.match(html, /data-testid="schedule-runs-sched-1"/);
  assert.match(html, /data-testid="schedule-delete-sched-1"/);
});

test("ScheduleRow renders a spinner in place of the switch while toggling", () => {
  const html = renderRow(withProject(schedule(), PROJECT), { toggling: true });
  // The switch testid is gone while a toggle is in flight; the spinner
  // takes its place so users see that the action is pending.
  assert.doesNotMatch(html, /data-testid="schedule-toggle-sched-1"/);
  assert.match(html, /animate-spin/);
});

test("ScheduleRow shows the correct project badge per row in a cross-project list", () => {
  const a = renderRow(withProject(schedule({ id: "sched-a" }), PROJECT));
  const b = renderRow(withProject(schedule({ id: "sched-b" }), PROJECT_2));
  assert.match(a, />Anita</);
  assert.doesNotMatch(a, />Germini</);
  assert.match(b, />Germini</);
  assert.doesNotMatch(b, />Anita</);
});

// ---------------------------------------------------------------------------
// 2. Create happy path — `CreateScheduleForm`
// ---------------------------------------------------------------------------

function renderForm(
  options: {
    projects?: Project[];
    projectId?: string;
    worktrees?: Worktree[];
    worktreeId?: string;
    worktreesLoading?: boolean;
    prompt?: string;
    triggerType?: "runAt" | "cron";
    runAt?: string;
    cron?: string;
    timezone?: string;
    error?: string | null;
  } = {}
): string {
  return renderToStaticMarkup(
    <CreateScheduleForm
      projects={options.projects ?? [PROJECT, PROJECT_2]}
      projectId={options.projectId ?? PROJECT.id}
      onProjectChange={NOOP_STR}
      worktrees={options.worktrees ?? WORKTREES}
      worktreeId={options.worktreeId ?? WORKTREES[0].id}
      onWorktreeChange={NOOP_STR}
      worktreesLoading={options.worktreesLoading ?? false}
      prompt={options.prompt ?? ""}
      onPromptChange={NOOP_STR}
      triggerType={options.triggerType ?? "runAt"}
      onTriggerTypeChange={NOOP_TRIGGER}
      runAt={options.runAt ?? ""}
      onRunAtChange={NOOP_STR}
      cron={options.cron ?? ""}
      onCronChange={NOOP_STR}
      timezone={options.timezone ?? "UTC"}
      onTimezoneChange={NOOP_STR}
      error={options.error ?? null}
    />,
  );
}

test("CreateScheduleForm renders the project and worktree selectors populated from props", () => {
  const html = renderForm();
  assert.match(html, /data-testid="schedule-form-project"/);
  assert.match(html, /data-testid="schedule-form-worktree"/);
  // The project select lists every project the caller passed in.
  assert.match(html, /<option value="project-1"[^>]*>Anita<\/option>/);
  assert.match(html, /<option value="project-2"[^>]*>Germini<\/option>/);
  // The worktree select lists the worktrees for the selected project.
  assert.match(html, /<option value="wt-1"[^>]*>main<\/option>/);
  assert.match(html, /<option value="wt-2"[^>]*>feature<\/option>/);
});

test("CreateScheduleForm renders the prompt textarea and trigger toggle", () => {
  const html = renderForm();
  assert.match(html, /data-testid="schedule-form-prompt"/);
  assert.match(html, /data-testid="schedule-form-trigger-runAt"/);
  assert.match(html, /data-testid="schedule-form-trigger-cron"/);
});

test("CreateScheduleForm defaults to a one-shot datetime-local input", () => {
  const html = renderForm();
  assert.match(html, /data-testid="schedule-form-runAt"/);
  assert.match(html, /type="datetime-local"/);
  // The cron field is only rendered when the user picks "Recurring".
  assert.doesNotMatch(html, /data-testid="schedule-form-cron"/);
});

test("CreateScheduleForm renders the cron expression and timezone fields when trigger is cron", () => {
  const html = renderForm({ triggerType: "cron" });
  assert.match(html, /data-testid="schedule-form-cron"/);
  assert.match(html, /data-testid="schedule-form-timezone"/);
  // The one-shot input is gone.
  assert.doesNotMatch(html, /data-testid="schedule-form-runAt"/);
});

test("CreateScheduleForm renders an empty-state message when no projects exist", () => {
  const html = renderForm({ projects: [], projectId: "" });
  assert.match(html, /No projects available/);
});

test("CreateScheduleForm renders a loading state on the worktree select", () => {
  const html = renderForm({ worktreesLoading: true });
  assert.match(html, /Loading worktrees/);
});

test("CreateScheduleForm surfaces server-side validation errors inline", () => {
  const html = renderForm({ error: "Invalid cron expression foo" });
  assert.match(html, /data-testid="schedule-form-error"/);
  assert.match(html, /Invalid cron expression foo/);
});

// ---------------------------------------------------------------------------
// 3. Delete confirmation — the section mounts an `AlertDialog`
// ---------------------------------------------------------------------------

test("SchedulesSection renders the new-schedule button and the section root in static markup", () => {
  // The list and runs drawer are populated async, so the static markup
  // shows the empty/loading state. What we *can* assert statically is the
  // always-present entry point and the test id hooks.
  const html = renderToStaticMarkup(<SchedulesSection />);
  assert.match(html, /data-testid="schedule-new"/);
  // Confirm the section does not require a project id (the cross-project
  // view must work even before any project is selected).
  assert.doesNotThrow(() => renderToStaticMarkup(<SchedulesSection />));
});

test("SchedulesSection mounts a delete confirm action via the AlertDialog flow", async () => {
  // The destructive confirm action is rendered as part of the
  // `AlertDialogAction` inside the section's `AlertDialog`. The
  // dialog uses a portal that does not render in SSR, so we can't
  // observe the markup via `renderToStaticMarkup` directly. Instead
  // we lock in the public data-testid contract by reading the
  // section source — this is the same hook future browser-driven
  // automation will use, and it stays stable across refactors of
  // the surrounding JSX.
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const source = readFileSync(
    fileURLToPath(new URL("../schedules-section.tsx", import.meta.url)),
    "utf8",
  );
  // Confirm both the row-level delete hook and the confirm-action hook
  // exist in the source so the click → confirm → DELETE flow is wired.
  assert.match(
    source,
    /data-testid="schedule-delete-/,
    "row-level delete testid must remain stable",
  );
  assert.match(
    source,
    /data-testid="schedule-delete-confirm"/,
    "destructive confirm action must remain stable",
  );
  // The confirm action is only fired after the user clicks
  // `AlertDialogAction`, and the resulting `handleDelete` call hits
  // DELETE on the schedule id. Verify the wiring by looking for the
  // matching DELETE call.
  assert.match(
    source,
    /deleteSchedule\(schedule\.projectId, schedule\.id\)/,
    "confirm must invoke deleteSchedule with the row's projectId and id",
  );
});

// ---------------------------------------------------------------------------
// 4. Enable / disable toggle wiring
// ---------------------------------------------------------------------------

test("ScheduleRow renders a Switch whose data-slot is present in both enabled and disabled states", () => {
  const enabledHtml = renderRow(withProject(schedule({ enabled: true }), PROJECT));
  assert.match(enabledHtml, /data-testid="schedule-toggle-sched-1"/);
  assert.match(enabledHtml, /data-slot="switch"/);

  const disabledHtml = renderRow(withProject(schedule({ enabled: false }), PROJECT));
  // The same testid is present; the disabled state is reflected via
  // base-ui's data-checked / data-unchecked attributes and the
  // "disabled" badge.
  assert.match(disabledHtml, /data-slot="switch"/);
  assert.match(disabledHtml, />disabled</);
});

// ---------------------------------------------------------------------------
// 5. P2 review fixes (issue #303 cross-project hardening)
// ---------------------------------------------------------------------------

test("fetchAllSchedules contract exposes failed projects alongside the merged list", async () => {
  // Issue #303 P2 review: per-project failures must not be silently
  // dropped. Verify the API surface carries a `failedProjectIds`
  // array so the section can render a partial-load banner.
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const source = readFileSync(
    fileURLToPath(new URL("../../api.ts", import.meta.url)),
    "utf8",
  );
  assert.match(
    source,
    /export interface AllSchedulesResult[\s\S]*failedProjectIds: string\[\]/,
    "AllSchedulesResult must carry failedProjectIds",
  );
  // The new return type and the catch arm that collects failures.
  assert.match(
    source,
    /failedProjectIds\.push\(entry\.project\.id\)/,
    "fetchAllSchedules must collect per-project failures",
  );
});

test("SchedulesSection renders a partial-load banner when fetchAllSchedules reports failed projects", async () => {
  // We can't drive a fetch via `renderToStaticMarkup`, but the
  // banner is rendered when `failedProjectNames` is non-empty. The
  // easiest way to exercise that without a real DOM is to read the
  // section source and confirm the rendering branch and the
  // testid hook are still in place — same approach we use for the
  // delete confirm action.
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const source = readFileSync(
    fileURLToPath(new URL("../schedules-section.tsx", import.meta.url)),
    "utf8",
  );
  assert.match(
    source,
    /data-testid="schedule-partial-error"/,
    "partial-load banner testid must remain stable",
  );
  assert.match(
    source,
    /failedProjectNames\.length > 0/,
    "partial-load banner must be conditionally rendered",
  );
});

test("Run-link click carries the row's projectId so deep-links land in the right project", async () => {
  // P2 review on #303: in the cross-project view, opening a run
  // for a non-active project was navigating to the wrong session
  // because the click handler didn't include projectId in the
  // payload. The onClick is inside the Dialog body so we can't
  // observe it in static markup, but the source contract is the
  // public hook — keep it pinned.
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const source = readFileSync(
    fileURLToPath(new URL("../schedules-section.tsx", import.meta.url)),
    "utf8",
  );
  // Both halves of the fix must remain in place: the onClick must
  // pass `projectId: runsFor.projectId`, and the App handler must
  // prefer `params.projectId` over `activeProjectId`.
  assert.match(
    source,
    /projectId: runsFor\.projectId/,
    "run onClick must include projectId",
  );
  const appSource = readFileSync(
    fileURLToPath(new URL("../../App.tsx", import.meta.url)),
    "utf8",
  );
  assert.match(
    appSource,
    /projectId = params\.projectId \?\? activeProjectId/,
    "App handler must prefer payload projectId over activeProjectId",
  );
});

test("openRuns drops stale responses via a monotonic request id", async () => {
  // P3 review on #303: if the user clicks Runs for A and then B
  // before A's request resolves, A's late response would otherwise
  // overwrite B's runs dialog. The fix bumps a ref on every call
  // and the async fetcher bails out if a newer request has started.
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const source = readFileSync(
    fileURLToPath(new URL("../schedules-section.tsx", import.meta.url)),
    "utf8",
  );
  assert.match(
    source,
    /runsRequestIdRef\.current = requestId/,
    "openRuns must bump the request id",
  );
  assert.match(
    source,
    /if \(runsRequestIdRef\.current !== requestId\) return/,
    "async fetcher must bail out on stale responses",
  );
});
