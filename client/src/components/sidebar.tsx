import { useState, useEffect, useCallback } from "react";
import {
  PenSquare,
  FolderOpen,
  FolderPlus,
  GitBranch,
  GitBranchPlus,
  ChevronDown,
  ChevronRight,
  Settings,
  Trash2,
  Pencil,
  MessageSquare,
  Archive,
  Loader2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  fetchSessions,
  fetchSessionRuntime,
  fetchWorktrees,
  deleteProject,
  deleteWorktree,
  archiveSession,
  type Project,
  type Session,
  type Worktree,
} from "../api.ts";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogClose,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";

interface SidebarProps {
  projects: Project[];
  activeProjectId: string | null;
  activeWorktreeId?: string;
  activeSessionId?: string;
  completedSessions?: Set<string>;
  onSelectProject: (projectId: string) => void;
  onSelectSession: (projectId: string, sessionId: string, worktreeId?: string) => void;
  onNewThread: (projectId: string, worktreeId?: string) => void;
  onNewProject: () => void;
  onEditProject: (projectId: string) => void;
  onNewWorktree: (projectId: string) => void;
  onProjectsChanged: () => void;
  onSettings: () => void;
}

interface WorktreeWithSessions extends Worktree {
  sessions: Session[];
  isExpanded: boolean;
}

interface ProjectWithWorktrees extends Project {
  worktrees: WorktreeWithSessions[];
  isExpanded: boolean;
}

export function Sidebar({
  projects,
  activeProjectId,
  activeWorktreeId,
  activeSessionId,
  onSelectProject,
  onSelectSession,
  onNewThread,
  onNewProject,
  onEditProject,
  onNewWorktree,
  onProjectsChanged,
  onSettings,
  completedSessions,
}: SidebarProps) {
  const [projectData, setProjectData] = useState<ProjectWithWorktrees[]>([]);
  const [archivedIds, setArchivedIds] = useState<Set<string>>(new Set());
  const [activeSessionIds, setActiveSessionIds] = useState<Set<string>>(new Set());
  const [confirmDeleteProjectId, setConfirmDeleteProjectId] = useState<string | null>(null);
  const [confirmDeleteWorktree, setConfirmDeleteWorktree] = useState<
    { projectId: string; worktreeId: string; name: string } | null
  >(null);

  const refreshActiveSessions = useCallback(
    async (data: ProjectWithWorktrees[]) => {
      const entries = await Promise.all(
        data.flatMap((project) =>
          project.worktrees.flatMap((worktree) =>
            worktree.sessions
              .filter((s) => !archivedIds.has(s.id))
              .map(async (session) => ({
                sessionId: session.id,
                runtime: await fetchSessionRuntime(project.id, session.id, worktree.id),
              }))
          )
        )
      );
      setActiveSessionIds(
        new Set(entries.filter((e) => e.runtime.active).map((e) => e.sessionId))
      );
    },
    [archivedIds]
  );

  const loadAll = useCallback(async () => {
    const next = await Promise.all(
      projects.map(async (project) => {
        const worktrees = await fetchWorktrees(project.id);
        const wtWithSessions = await Promise.all(
          worktrees.map(async (wt) => {
            const sessions = await fetchSessions(project.id, wt.id);
            const existingProject = projectData.find((p) => p.id === project.id);
            const existingWt = existingProject?.worktrees.find((w) => w.id === wt.id);
            const isActiveWt =
              wt.id === activeWorktreeId ||
              (!activeWorktreeId && wt.isMain && project.id === activeProjectId);
            return {
              ...wt,
              sessions: sessions.filter((s) => !archivedIds.has(s.id)),
              isExpanded: existingWt?.isExpanded ?? isActiveWt,
            } satisfies WorktreeWithSessions;
          })
        );
        const existing = projectData.find((p) => p.id === project.id);
        return {
          ...project,
          worktrees: wtWithSessions,
          isExpanded: existing?.isExpanded ?? project.id === activeProjectId,
        } satisfies ProjectWithWorktrees;
      })
    );
    setProjectData(next);
    await refreshActiveSessions(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projects, activeProjectId, activeWorktreeId, archivedIds]);

  useEffect(() => {
    loadAll().catch(() => {});
  }, [loadAll]);

  useEffect(() => {
    if (activeSessionIds.size === 0) return;
    const interval = window.setInterval(() => {
      refreshActiveSessions(projectData).catch(() => {});
    }, 2000);
    return () => window.clearInterval(interval);
  }, [activeSessionIds, projectData, refreshActiveSessions]);

  const toggleProject = (id: string) => {
    setProjectData((prev) =>
      prev.map((p) => (p.id === id ? { ...p, isExpanded: !p.isExpanded } : p))
    );
  };

  const toggleWorktree = (projectId: string, worktreeId: string) => {
    setProjectData((prev) =>
      prev.map((p) =>
        p.id === projectId
          ? {
              ...p,
              worktrees: p.worktrees.map((w) =>
                w.id === worktreeId ? { ...w, isExpanded: !w.isExpanded } : w
              ),
            }
          : p
      )
    );
  };

  const confirmDeleteProject = async () => {
    if (!confirmDeleteProjectId) return;
    await deleteProject(confirmDeleteProjectId);
    setConfirmDeleteProjectId(null);
    onProjectsChanged();
  };

  const confirmDeleteWorktreeAction = async () => {
    if (!confirmDeleteWorktree) return;
    const { projectId, worktreeId } = confirmDeleteWorktree;
    try {
      await deleteWorktree(projectId, worktreeId);
      setConfirmDeleteWorktree(null);
      await loadAll();
      toast.success("Worktree deleted");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to delete worktree");
    }
  };

  const formatTime = (iso: string) => {
    const diff = Date.now() - new Date(iso).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 60) return `${mins}m`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h`;
    const days = Math.floor(hours / 24);
    return `${days}d`;
  };

  return (
    <aside className="flex h-full w-64 flex-col border-r border-border bg-sidebar">
      <div className="flex flex-col gap-1 p-3">
        <button
          onClick={onNewProject}
          className="flex items-center gap-3 rounded-md px-3 py-2 text-sm text-sidebar-foreground hover:bg-sidebar-accent transition-colors"
        >
          <FolderPlus className="h-4 w-4" />
          <span>New project</span>
        </button>
      </div>

      <Separator />

      <ScrollArea className="flex-1 overflow-hidden px-3">
        <div className="flex items-center justify-between py-3">
          <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Projects
          </span>
        </div>

        <div className="flex flex-col gap-1 pb-3">
          {projectData.length === 0 ? (
            <span className="px-3 py-2 text-xs text-muted-foreground">No projects yet</span>
          ) : (
            projectData.map((project) => (
              <div key={project.id}>
                <div className="group flex items-center">
                  <button
                    onClick={() => {
                      toggleProject(project.id);
                      onSelectProject(project.id);
                    }}
                    className={cn(
                      "flex flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors min-w-0",
                      project.id === activeProjectId
                        ? "text-sidebar-foreground"
                        : "text-sidebar-foreground/80 hover:bg-sidebar-accent"
                    )}
                  >
                    {project.isExpanded ? (
                      <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    ) : (
                      <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    )}
                    <FolderOpen className="h-4 w-4 shrink-0 text-muted-foreground" />
                    <span className="truncate">{project.name}</span>
                  </button>
                  <button
                    onClick={(e) => { e.stopPropagation(); onNewWorktree(project.id); }}
                    title="New worktree"
                    className="opacity-0 group-hover:opacity-100 rounded p-1 text-muted-foreground hover:text-sidebar-foreground transition-all"
                  >
                    <GitBranchPlus className="h-3.5 w-3.5" />
                  </button>
                  <button
                    onClick={(e) => { e.stopPropagation(); onEditProject(project.id); }}
                    title="Edit project"
                    className="opacity-0 group-hover:opacity-100 rounded p-1 text-muted-foreground hover:text-sidebar-foreground transition-all"
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </button>
                  <button
                    onClick={(e) => { e.stopPropagation(); setConfirmDeleteProjectId(project.id); }}
                    title="Delete project"
                    className="opacity-0 group-hover:opacity-100 rounded p-1 text-muted-foreground hover:text-destructive transition-all"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>

                {project.isExpanded && (
                  <div className="ml-4 flex flex-col">
                    {project.worktrees.length === 0 ? (
                      <span className="px-4 py-1.5 text-xs text-muted-foreground">
                        No worktrees
                      </span>
                    ) : (
                      project.worktrees.map((worktree) => (
                        <div key={worktree.id}>
                          <div className="group/worktree flex items-center">
                            <button
                              onClick={() => toggleWorktree(project.id, worktree.id)}
                              className={cn(
                                "flex flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors min-w-0",
                                worktree.id === activeWorktreeId
                                  ? "text-sidebar-foreground"
                                  : "text-sidebar-foreground/80 hover:bg-sidebar-accent"
                              )}
                            >
                              {worktree.isExpanded ? (
                                <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                              ) : (
                                <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                              )}
                              <GitBranch className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                              <span className="truncate">
                                {worktree.name}
                                {worktree.setupExitCode != null && worktree.setupExitCode !== 0 && (
                                  <span className="ml-1 text-destructive" title="Setup failed">!</span>
                                )}
                              </span>
                            </button>
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                onNewThread(project.id, worktree.id);
                              }}
                              title="New session"
                              className="opacity-0 group-hover/worktree:opacity-100 rounded p-1 text-muted-foreground hover:text-sidebar-foreground transition-all"
                            >
                              <PenSquare className="h-3.5 w-3.5" />
                            </button>
                            {!worktree.isMain && (
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setConfirmDeleteWorktree({
                                    projectId: project.id,
                                    worktreeId: worktree.id,
                                    name: worktree.name,
                                  });
                                }}
                                title="Delete worktree"
                                className="opacity-0 group-hover/worktree:opacity-100 rounded p-1 text-muted-foreground hover:text-destructive transition-all"
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </button>
                            )}
                          </div>

                          {worktree.isExpanded && (
                            <div className="ml-4 flex flex-col">
                              {worktree.sessions.length === 0 ? (
                                <span className="px-4 py-1.5 text-xs text-muted-foreground">
                                  No sessions
                                </span>
                              ) : (
                                worktree.sessions.map((session) => (
                                  <div key={session.id} className="group/session flex items-center">
                                    <button
                                      onClick={() =>
                                        onSelectSession(project.id, session.id, worktree.id)
                                      }
                                      className={cn(
                                        "flex flex-1 items-center justify-between gap-3 rounded-md px-4 py-1.5 text-sm transition-colors min-w-0",
                                        session.id === activeSessionId
                                          ? "bg-sidebar-accent text-sidebar-foreground"
                                          : "text-sidebar-foreground/80 hover:bg-sidebar-accent"
                                      )}
                                    >
                                      <span className="flex min-w-0 flex-1 items-center gap-2 truncate pr-2">
                                        <MessageSquare className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                                        <span className="truncate">
                                          {session.title || session.id.slice(0, 8)}
                                        </span>
                                        {completedSessions?.has(session.id) && (
                                          <span className="h-2 w-2 shrink-0 rounded-full bg-green-500" />
                                        )}
                                      </span>
                                      {activeSessionIds.has(session.id) ? (
                                        <Loader2 className="h-3 w-3 shrink-0 animate-spin text-muted-foreground group-hover/session:hidden" />
                                      ) : (
                                        <span className="shrink-0 text-xs text-muted-foreground group-hover/session:hidden">
                                          {formatTime(session.lastActiveAt)}
                                        </span>
                                      )}
                                      <span
                                        role="button"
                                        tabIndex={0}
                                        onClick={async (e) => {
                                          e.stopPropagation();
                                          setArchivedIds((prev) => new Set(prev).add(session.id));
                                          setProjectData((prev) =>
                                            prev.map((p) =>
                                              p.id === project.id
                                                ? {
                                                    ...p,
                                                    worktrees: p.worktrees.map((w) =>
                                                      w.id === worktree.id
                                                        ? {
                                                            ...w,
                                                            sessions: w.sessions.filter(
                                                              (s) => s.id !== session.id
                                                            ),
                                                          }
                                                        : w
                                                    ),
                                                  }
                                                : p
                                            )
                                          );
                                          toast.success("Session archived");
                                          await archiveSession(project.id, session.id, worktree.id);
                                        }}
                                        className="hidden shrink-0 rounded p-0.5 text-muted-foreground hover:text-sidebar-foreground transition-colors group-hover/session:inline-flex"
                                        title="Archive session"
                                      >
                                        <Archive className="h-3.5 w-3.5" />
                                      </span>
                                    </button>
                                  </div>
                                ))
                              )}
                            </div>
                          )}
                        </div>
                      ))
                    )}
                  </div>
                )}
              </div>
            ))
          )}
        </div>
      </ScrollArea>

      <Separator />
      <div className="p-3">
        <button
          onClick={onSettings}
          className="flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm text-sidebar-foreground hover:bg-sidebar-accent transition-colors"
        >
          <Settings className="h-4 w-4" />
          <span>Settings</span>
        </button>
      </div>

      <Dialog
        open={!!confirmDeleteProjectId}
        onOpenChange={(open) => { if (!open) setConfirmDeleteProjectId(null); }}
      >
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Delete project</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete{" "}
              <span className="font-medium text-foreground">
                {projectData.find((p) => p.id === confirmDeleteProjectId)?.name}
              </span>
              ? This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
            <Button variant="destructive" onClick={confirmDeleteProject}>
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={!!confirmDeleteWorktree}
        onOpenChange={(open) => { if (!open) setConfirmDeleteWorktree(null); }}
      >
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Delete worktree</DialogTitle>
            <DialogDescription>
              Delete worktree{" "}
              <span className="font-medium text-foreground">
                {confirmDeleteWorktree?.name}
              </span>
              ? This removes the directory from disk. The git branch is kept.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
            <Button variant="destructive" onClick={confirmDeleteWorktreeAction}>
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </aside>
  );
}
