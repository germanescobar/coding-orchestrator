import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Check,
  Clock,
  Loader2,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from "@/components/ui/alert-dialog";
import {
  createSchedule,
  deleteSchedule,
  fetchScheduleRuns,
  fetchSchedules,
  fetchWorktrees,
  setScheduleEnabled,
  type Schedule,
  type ScheduleInput,
  type ScheduleRun,
  type Worktree,
} from "../api.ts";

/*
 * Settings panel for the active project's scheduled sessions
 * (issue #303). The Schedules REST surface (server/routes/schedules.ts)
 * already mirrors the CLI, so this component is a thin client: list
 * schedules, create one, toggle enabled, delete (with confirm), and
 * peek at run history.
 *
 * Editing an existing schedule's trigger is intentionally not exposed —
 * the server has no PUT route for it and the issue lists it as a
 * follow-up. The form below requires either a one-shot ISO timestamp
 * (`runAt`) or a cron expression plus timezone; the server validates
 * both and surfaces any failure as a 400, which we render inline.
 *
 * Session deep links from a `firedAt` run: the row exposes the
 * `sessionId` as a button that asks the parent to switch views to
 * that session via the `onOpenSession` prop. The view switch reuses
 * the same path `controller://` links take in the transcript, but
 * runs only carry the bare id (no envelope) so we forward a derived
 * target.
 */

const COMMON_TIMEZONES = [
  "UTC",
  "America/Los_Angeles",
  "America/Denver",
  "America/Chicago",
  "America/New_York",
  "America/Sao_Paulo",
  "Europe/London",
  "Europe/Berlin",
  "Europe/Paris",
  "Europe/Madrid",
  "Africa/Johannesburg",
  "Asia/Dubai",
  "Asia/Kolkata",
  "Asia/Singapore",
  "Asia/Tokyo",
  "Asia/Seoul",
  "Australia/Sydney",
  "Pacific/Auckland",
];

interface SchedulesSectionProps {
  projectId: string;
  /**
   * Switch the main view to the given session. Used by the runs panel
   * to deep-link a fired schedule's resulting session. Optional — the
   * section still works without it, the link just becomes a no-op.
   */
  onOpenSession?: (params: { sessionId: string; worktreeId?: string }) => void;
}

export function SchedulesSection({ projectId, onOpenSession }: SchedulesSectionProps) {
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [worktrees, setWorktrees] = useState<Worktree[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [runsFor, setRunsFor] = useState<Schedule | null>(null);
  const [runs, setRuns] = useState<ScheduleRun[]>([]);
  const [runsLoading, setRunsLoading] = useState(false);
  const [runsError, setRunsError] = useState<string | null>(null);
  const [togglingId, setTogglingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [list, worktreeList] = await Promise.all([
        fetchSchedules(projectId, true),
        fetchWorktrees(projectId),
      ]);
      setSchedules(list);
      setWorktrees(worktreeList);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load schedules");
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleToggle = useCallback(
    async (schedule: Schedule, enabled: boolean) => {
      setTogglingId(schedule.id);
      try {
        const updated = await setScheduleEnabled(projectId, schedule.id, enabled);
        setSchedules((current) =>
          current.map((entry) => (entry.id === updated.id ? updated : entry))
        );
      } catch (err) {
        setError(
          err instanceof Error ? err.message : "Failed to update schedule"
        );
      } finally {
        setTogglingId(null);
      }
    },
    [projectId]
  );

  const handleDelete = useCallback(
    async (scheduleId: string) => {
      try {
        await deleteSchedule(projectId, scheduleId);
        setSchedules((current) => current.filter((entry) => entry.id !== scheduleId));
        if (runsFor?.id === scheduleId) {
          setRunsFor(null);
          setRuns([]);
        }
      } catch (err) {
        setError(
          err instanceof Error ? err.message : "Failed to delete schedule"
        );
      }
    },
    [projectId, runsFor]
  );

  const openRuns = useCallback(
    (schedule: Schedule) => {
      setRunsFor(schedule);
      setRuns([]);
      setRunsError(null);
      setRunsLoading(true);
      void (async () => {
        try {
          const list = await fetchScheduleRuns(projectId, schedule.id);
          setRuns(list);
        } catch (err) {
          setRunsError(
            err instanceof Error ? err.message : "Failed to load runs"
          );
        } finally {
          setRunsLoading(false);
        }
      })();
    },
    [projectId]
  );

  const worktreeName = useCallback(
    (id: string) => worktrees.find((w) => w.id === id)?.name ?? id,
    [worktrees]
  );

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-end">
        <Button
          size="sm"
          onClick={() => setCreateOpen(true)}
          data-testid="schedule-new"
          className="gap-1"
        >
          <Plus className="h-3.5 w-3.5" />
          New schedule
        </Button>
      </div>

      {loading && schedules.length === 0 && (
        <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading schedules...
        </div>
      )}

      {error && (
        <div
          className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive"
          data-testid="schedule-error"
        >
          {error}
        </div>
      )}

      <div className="space-y-2">
        {schedules.map((schedule) => (
          <ScheduleRow
            key={schedule.id}
            schedule={schedule}
            worktreeName={worktreeName(schedule.worktreeId)}
            onToggle={(enabled) => void handleToggle(schedule, enabled)}
            onDelete={() => setDeletingId(schedule.id)}
            onViewRuns={() => openRuns(schedule)}
            toggling={togglingId === schedule.id}
          />
        ))}

        {!loading && schedules.length === 0 && (
          <div
            className="rounded-lg border border-dashed border-border p-6 text-center"
            data-testid="schedule-empty"
          >
            <p className="text-sm text-muted-foreground">
              No schedules yet. Create one to start a session later or on a
              recurring basis.
            </p>
          </div>
        )}
      </div>

      <CreateScheduleDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        projectId={projectId}
        worktrees={worktrees}
        onCreated={async (created) => {
          setCreateOpen(false);
          setSchedules((current) => [created, ...current]);
        }}
      />

      <AlertDialog
        open={deletingId !== null}
        onOpenChange={(open) => {
          if (!open) setDeletingId(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this schedule?</AlertDialogTitle>
            <AlertDialogDescription>
              The schedule and its run history will be removed. This cannot
              be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              data-testid="schedule-delete-confirm"
              onClick={() => {
                const id = deletingId;
                setDeletingId(null);
                if (id) void handleDelete(id);
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog
        open={runsFor !== null}
        onOpenChange={(open) => {
          if (!open) {
            setRunsFor(null);
            setRuns([]);
            setRunsError(null);
          }
        }}
      >
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Clock className="h-4 w-4" />
              Runs
            </DialogTitle>
            {runsFor && (
              <DialogDescription>
                {worktreeName(runsFor.worktreeId)} ·{" "}
                {runsFor.cron
                  ? `cron=${runsFor.cron} (${runsFor.timezone})`
                  : runsFor.runAt
                    ? `one-shot at ${runsFor.runAt}`
                    : ""}
              </DialogDescription>
            )}
          </DialogHeader>
          {runsLoading ? (
            <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading runs...
            </div>
          ) : runsError ? (
            <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {runsError}
            </div>
          ) : runs.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border p-4 text-center text-sm text-muted-foreground">
              No runs yet.
            </div>
          ) : (
            <div className="max-h-80 overflow-y-auto rounded-md border border-border divide-y divide-border">
              {runs.map((run, idx) => (
                <div
                  key={`${run.firedAt}-${idx}`}
                  className="flex flex-col gap-1 px-3 py-2 text-xs"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-mono text-foreground">
                      {formatDate(run.firedAt)}
                    </span>
                    {run.error ? (
                      <Badge variant="destructive" className="text-[10px]">
                        error
                      </Badge>
                    ) : run.sessionId ? (
                      <button
                        type="button"
                        className="rounded font-mono text-primary hover:underline disabled:no-underline disabled:opacity-50"
                        data-testid={`schedule-run-session-${idx}`}
                        disabled={!onOpenSession}
                        onClick={() => {
                          if (!onOpenSession || !run.sessionId || !runsFor) return;
                          onOpenSession({
                            sessionId: run.sessionId,
                            worktreeId: runsFor.worktreeId,
                          });
                        }}
                        title={
                          onOpenSession
                            ? "Open this session"
                            : "Session deep-link unavailable"
                        }
                      >
                        {run.sessionId.slice(0, 8)}
                      </button>
                    ) : (
                      <Badge variant="outline" className="text-[10px]">
                        no session
                      </Badge>
                    )}
                  </div>
                  {run.error && (
                    <div className="break-words text-destructive">
                      {run.error}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setRunsFor(null)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

interface ScheduleRowProps {
  schedule: Schedule;
  worktreeName: string;
  toggling: boolean;
  onToggle: (enabled: boolean) => void;
  onDelete: () => void;
  onViewRuns: () => void;
}

export function ScheduleRow({
  schedule,
  worktreeName,
  toggling,
  onToggle,
  onDelete,
  onViewRuns,
}: ScheduleRowProps) {
  const triggerLabel = schedule.cron
    ? `cron: ${schedule.cron}`
    : schedule.runAt
      ? `one-shot: ${formatDate(schedule.runAt)}`
      : "no trigger";
  return (
    <div
      className="flex flex-col gap-2 rounded-lg border border-border p-3 md:flex-row md:items-start md:gap-3"
      data-testid={`schedule-row-${schedule.id}`}
    >
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium truncate" title={worktreeName}>
            {worktreeName}
          </span>
          <Badge variant="outline" className="text-[10px]">
            {schedule.cron ? "cron" : "runAt"}
          </Badge>
          <Badge variant="secondary" className="text-[10px]">
            {schedule.source}
          </Badge>
          {!schedule.enabled && (
            <Badge variant="destructive" className="text-[10px]">
              disabled
            </Badge>
          )}
        </div>
        <p className="mt-1 line-clamp-2 break-words text-xs text-muted-foreground">
          {schedule.prompt}
        </p>
        <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
          <span>{triggerLabel}</span>
          <span>next: {formatDate(schedule.nextRunAt)}</span>
          {schedule.lastRunAt && (
            <span>last: {formatDate(schedule.lastRunAt)}</span>
          )}
        </div>
        {schedule.lastError && (
          <div className="mt-1 flex items-start gap-1 rounded border border-destructive/30 bg-destructive/10 px-2 py-1 text-[11px] text-destructive">
            <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
            <span className="break-words">{schedule.lastError}</span>
          </div>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Button
          size="sm"
          variant="ghost"
          data-testid={`schedule-runs-${schedule.id}`}
          onClick={onViewRuns}
          className="gap-1 text-xs"
        >
          <Clock className="h-3.5 w-3.5" />
          Runs
        </Button>
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span className="sr-only">Enabled</span>
          {toggling ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
          ) : (
            <Switch
              checked={schedule.enabled}
              onCheckedChange={(checked) => onToggle(checked)}
              data-testid={`schedule-toggle-${schedule.id}`}
            />
          )}
        </label>
        <Button
          size="icon-sm"
          variant="ghost"
          data-testid={`schedule-delete-${schedule.id}`}
          onClick={onDelete}
          className="text-muted-foreground hover:text-destructive"
          title="Delete schedule"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );
}

interface CreateScheduleDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  worktrees: Worktree[];
  onCreated: (schedule: Schedule) => void;
}

export function CreateScheduleDialog({
  open,
  onOpenChange,
  projectId,
  worktrees,
  onCreated,
}: CreateScheduleDialogProps) {
  const [worktreeId, setWorktreeId] = useState("");
  const [prompt, setPrompt] = useState("");
  const [triggerType, setTriggerType] = useState<"runAt" | "cron">("runAt");
  const [runAt, setRunAt] = useState("");
  const [cron, setCron] = useState("");
  const [timezone, setTimezone] = useState("UTC");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset the form whenever the dialog is closed (so reopening gives a clean
  // slate) and seed `worktreeId` once worktrees load.
  useEffect(() => {
    if (!open) {
      setWorktreeId("");
      setPrompt("");
      setTriggerType("runAt");
      setRunAt("");
      setCron("");
      setTimezone("UTC");
      setError(null);
      setSaving(false);
      return;
    }
    setWorktreeId((current) => current || worktrees[0]?.id || "");
  }, [open, worktrees]);

  const canSave = useMemo(() => {
    if (!worktreeId || !prompt.trim()) return false;
    if (triggerType === "runAt") return runAt.trim().length > 0;
    return cron.trim().length > 0;
  }, [worktreeId, prompt, triggerType, runAt, cron]);

  const handleSubmit = async () => {
    setSaving(true);
    setError(null);
    try {
      const body: ScheduleInput = {
        worktreeId,
        prompt: prompt.trim(),
        createdBy: "ui",
      };
      if (triggerType === "runAt") {
        const parsed = new Date(runAt);
        if (Number.isNaN(parsed.getTime())) {
          throw new Error("Invalid date — pick a valid timestamp");
        }
        body.runAt = parsed.toISOString();
      } else {
        body.cron = cron.trim();
        body.timezone = timezone;
      }
      const created = await createSchedule(projectId, body);
      onCreated(created);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to create schedule"
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>New schedule</DialogTitle>
          <DialogDescription>
            Start a session on a worktree at a specific time (one-shot) or
            on a recurring cron expression.
          </DialogDescription>
        </DialogHeader>
        <CreateScheduleForm
          worktrees={worktrees}
          worktreeId={worktreeId}
          onWorktreeChange={setWorktreeId}
          prompt={prompt}
          onPromptChange={setPrompt}
          triggerType={triggerType}
          onTriggerTypeChange={setTriggerType}
          runAt={runAt}
          onRunAtChange={setRunAt}
          cron={cron}
          onCronChange={setCron}
          timezone={timezone}
          onTimezoneChange={setTimezone}
          error={error}
        />
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={saving}
          >
            <X className="h-3.5 w-3.5" />
            Cancel
          </Button>
          <Button
            onClick={() => void handleSubmit()}
            disabled={!canSave || saving}
            data-testid="schedule-form-save"
          >
            {saving ? (
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
            ) : (
              <Check className="mr-1.5 h-3.5 w-3.5" />
            )}
            Create schedule
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface CreateScheduleFormProps {
  worktrees: Worktree[];
  worktreeId: string;
  onWorktreeChange: (id: string) => void;
  prompt: string;
  onPromptChange: (value: string) => void;
  triggerType: "runAt" | "cron";
  onTriggerTypeChange: (value: "runAt" | "cron") => void;
  runAt: string;
  onRunAtChange: (value: string) => void;
  cron: string;
  onCronChange: (value: string) => void;
  timezone: string;
  onTimezoneChange: (value: string) => void;
  error: string | null;
}

/**
 * Form body for the create-schedule dialog. Extracted from the dialog
 * wrapper so the field markup is observable to `renderToStaticMarkup`
 * (Dialog uses a portal that does not render in SSR) and so the
 * regression test can assert on the field-level test ids directly.
 */
export function CreateScheduleForm({
  worktrees,
  worktreeId,
  onWorktreeChange,
  prompt,
  onPromptChange,
  triggerType,
  onTriggerTypeChange,
  runAt,
  onRunAtChange,
  cron,
  onCronChange,
  timezone,
  onTimezoneChange,
  error,
}: CreateScheduleFormProps) {
  return (
    <div className="space-y-3">
      <div>
        <label className="mb-1 block text-xs font-medium text-muted-foreground">
          Worktree
        </label>
        <select
          value={worktreeId}
          onChange={(e) => onWorktreeChange(e.target.value)}
          data-testid="schedule-form-worktree"
          className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
          disabled={worktrees.length === 0}
        >
          {worktrees.length === 0 && (
            <option value="">No worktrees available</option>
          )}
          {worktrees.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label className="mb-1 block text-xs font-medium text-muted-foreground">
          Prompt
        </label>
        <textarea
          value={prompt}
          onChange={(e) => onPromptChange(e.target.value)}
          rows={3}
          data-testid="schedule-form-prompt"
          placeholder="The prompt to send when the schedule fires"
          className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
        />
      </div>
      <div>
        <span className="mb-1 block text-xs font-medium text-muted-foreground">
          Trigger
        </span>
        <div className="flex gap-2">
          <Button
            type="button"
            size="sm"
            variant={triggerType === "runAt" ? "default" : "outline"}
            onClick={() => onTriggerTypeChange("runAt")}
            data-testid="schedule-form-trigger-runAt"
          >
            One-shot
          </Button>
          <Button
            type="button"
            size="sm"
            variant={triggerType === "cron" ? "default" : "outline"}
            onClick={() => onTriggerTypeChange("cron")}
            data-testid="schedule-form-trigger-cron"
          >
            Recurring
          </Button>
        </div>
      </div>
      {triggerType === "runAt" ? (
        <div>
          <label className="mb-1 block text-xs font-medium text-muted-foreground">
            Run at (local time)
          </label>
          <input
            type="datetime-local"
            value={runAt}
            onChange={(e) => onRunAtChange(e.target.value)}
            data-testid="schedule-form-runAt"
            className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
          />
        </div>
      ) : (
        <div className="space-y-2">
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">
              Cron expression
            </label>
            <input
              type="text"
              value={cron}
              onChange={(e) => onCronChange(e.target.value)}
              placeholder="*/5 * * * *"
              data-testid="schedule-form-cron"
              className="w-full rounded-md border border-border bg-transparent px-3 py-2 font-mono text-sm focus:outline-none focus:ring-1 focus:ring-ring"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">
              Timezone
            </label>
            <select
              value={timezone}
              onChange={(e) => onTimezoneChange(e.target.value)}
              data-testid="schedule-form-timezone"
              className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
            >
              {COMMON_TIMEZONES.map((tz) => (
                <option key={tz} value={tz}>
                  {tz}
                </option>
              ))}
            </select>
          </div>
        </div>
      )}
      {error && (
        <div
          className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive"
          data-testid="schedule-form-error"
        >
          {error}
        </div>
      )}
    </div>
  );
}

/**
 * Render a date in a stable, short form. We avoid `toLocaleString` so SSR
 * (static markup) and CSR match — the Settings regression test renders
 * server-side and a locale-dependent string would fail across machines.
 */
function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  // YYYY-MM-DD HH:mm in UTC. Compact enough to fit on a row, but precise
  // enough to disambiguate near-future runs.
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(
      date.getUTCDate()
    )} ` +
    `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())} UTC`
  );
}
