import { useState, useEffect } from "react";
import {
  PenSquare,
  FolderOpen,
  FolderPlus,
  ChevronDown,
  ChevronRight,
  Settings,
  Trash2,
  MessageSquare,
  Archive,
  Loader2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  fetchSessions,
  fetchSessionRuntime,
  deleteProject,
  archiveSession,
  type Project,
  type Session,
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
  activeSessionId?: string;
  completedSessions?: Set<string>;
  onSelectProject: (projectId: string) => void;
  onSelectSession: (projectId: string, sessionId: string) => void;
  onNewThread: (projectId: string) => void;
  onNewProject: () => void;
  onProjectsChanged: () => void;
  onSettings: () => void;
}

interface ProjectWithSessions extends Project {
  sessions: Session[];
  isExpanded: boolean;
}

export function Sidebar({
  projects,
  activeProjectId,
  activeSessionId,
  onSelectProject,
  onSelectSession,
  onNewThread,
  onNewProject,
  onProjectsChanged,
  onSettings,
  completedSessions,
}: SidebarProps) {
  const [projectData, setProjectData] = useState<ProjectWithSessions[]>([]);
  const [archivedIds, setArchivedIds] = useState<Set<string>>(new Set());
  const [activeSessionIds, setActiveSessionIds] = useState<Set<string>>(new Set());

  const refreshActiveSessions = async (projectsToLoad: Project[]) => {
    const sessionsByProject = await Promise.all(
      projectsToLoad.map(async (project) => ({
        projectId: project.id,
        sessions: await fetchSessions(project.id),
      }))
    );

    const activeEntries = await Promise.all(
      sessionsByProject.flatMap(({ projectId, sessions }) =>
        sessions
          .filter((session) => !archivedIds.has(session.id))
          .map(async (session) => ({
            sessionId: session.id,
            runtime: await fetchSessionRuntime(projectId, session.id),
          }))
      )
    );

    setActiveSessionIds(
      new Set(
        activeEntries
          .filter(({ runtime }) => runtime.active)
          .map(({ sessionId }) => sessionId)
      )
    );
  };

  useEffect(() => {
    const load = async () => {
      const data = await Promise.all(
        projects.map(async (p) => {
          const sessions = await fetchSessions(p.id);
          const existing = projectData.find((d) => d.id === p.id);
          return {
            ...p,
            sessions: sessions.filter((s) => !archivedIds.has(s.id)),
            isExpanded: existing?.isExpanded ?? p.id === activeProjectId,
          };
        })
      );
      setProjectData(data);
      await refreshActiveSessions(projects);
    };
    load().catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projects, activeProjectId, activeSessionId, archivedIds]);

  useEffect(() => {
    if (activeSessionIds.size === 0) return;

    const interval = window.setInterval(() => {
      refreshActiveSessions(projects).catch(() => {});
    }, 2000);

    return () => window.clearInterval(interval);
  }, [activeSessionIds, projects, archivedIds]);

  const toggleProject = (id: string) => {
    setProjectData((prev) =>
      prev.map((p) =>
        p.id === id ? { ...p, isExpanded: !p.isExpanded } : p
      )
    );
  };

  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const handleDelete = (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    setConfirmDeleteId(id);
  };

  const confirmDelete = async () => {
    if (!confirmDeleteId) return;
    await deleteProject(confirmDeleteId);
    setConfirmDeleteId(null);
    onProjectsChanged();
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
      {/* Top actions */}
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

      {/* Projects & Sessions */}
      <ScrollArea className="flex-1 overflow-hidden px-3">
        <div className="flex items-center justify-between py-3">
          <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Projects
          </span>
        </div>

        <div className="flex flex-col gap-1 pb-3">
          {projectData.length === 0 ? (
            <span className="px-3 py-2 text-xs text-muted-foreground">
              No projects yet
            </span>
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
                    onClick={(e) => {
                      e.stopPropagation();
                      onNewThread(project.id);
                    }}
                    className="opacity-0 group-hover:opacity-100 rounded p-1 text-muted-foreground hover:text-sidebar-foreground transition-all"
                  >
                    <PenSquare className="h-3.5 w-3.5" />
                  </button>
                  <button
                    onClick={(e) => handleDelete(e, project.id)}
                    className="opacity-0 group-hover:opacity-100 rounded p-1 text-muted-foreground hover:text-destructive transition-all"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>

                {project.isExpanded && (
                  <div className="ml-4 flex flex-col">
                    {project.sessions.length === 0 ? (
                      <span className="px-4 py-1.5 text-xs text-muted-foreground">
                        No sessions
                      </span>
                    ) : (
                      project.sessions.map((session) => (
                        <div
                          key={session.id}
                          className="group/session flex items-center"
                        >
                          <button
                            onClick={() =>
                              onSelectSession(project.id, session.id)
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
                                          sessions: p.sessions.filter(
                                            (s) => s.id !== session.id
                                          ),
                                        }
                                      : p
                                  )
                                );
                                toast.success("Session archived");
                                await archiveSession(project.id, session.id);
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
      </ScrollArea>

      {/* Footer */}
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
        open={!!confirmDeleteId}
        onOpenChange={(open) => {
          if (!open) setConfirmDeleteId(null);
        }}
      >
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Delete project</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete{" "}
              <span className="font-medium text-foreground">
                {projectData.find((p) => p.id === confirmDeleteId)?.name}
              </span>
              ? This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" />}>
              Cancel
            </DialogClose>
            <Button variant="destructive" onClick={confirmDelete}>
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </aside>
  );
}
