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
} from "lucide-react";
import { cn } from "@/lib/utils";
import { fetchSessions, deleteProject, type Project, type Session } from "../api.ts";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";

interface SidebarProps {
  projects: Project[];
  activeProjectId: string | null;
  activeSessionId?: string;
  onSelectProject: (projectId: string) => void;
  onSelectSession: (projectId: string, sessionId: string) => void;
  onNewThread: (projectId: string) => void;
  onNewProject: () => void;
  onProjectsChanged: () => void;
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
}: SidebarProps) {
  const [projectData, setProjectData] = useState<ProjectWithSessions[]>([]);

  useEffect(() => {
    const load = async () => {
      const data = await Promise.all(
        projects.map(async (p) => {
          const sessions = await fetchSessions(p.id);
          const existing = projectData.find((d) => d.id === p.id);
          return {
            ...p,
            sessions,
            isExpanded: existing?.isExpanded ?? p.id === activeProjectId,
          };
        })
      );
      setProjectData(data);
    };
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projects, activeProjectId]);

  const toggleProject = (id: string) => {
    setProjectData((prev) =>
      prev.map((p) =>
        p.id === id ? { ...p, isExpanded: !p.isExpanded } : p
      )
    );
  };

  const handleDelete = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    await deleteProject(id);
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
      <ScrollArea className="flex-1 px-3">
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
                        <button
                          key={session.id}
                          onClick={() =>
                            onSelectSession(project.id, session.id)
                          }
                          className={cn(
                            "flex items-center justify-between rounded-md px-4 py-1.5 text-sm transition-colors",
                            session.id === activeSessionId
                              ? "bg-sidebar-accent text-sidebar-foreground"
                              : "text-sidebar-foreground/80 hover:bg-sidebar-accent"
                          )}
                        >
                          <span className="flex items-center gap-2 truncate">
                            <MessageSquare className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                            <span className="truncate">
                              {session.id.slice(0, 8)}
                            </span>
                          </span>
                          <span className="shrink-0 text-xs text-muted-foreground">
                            {formatTime(session.lastActiveAt)}
                          </span>
                        </button>
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
        <button className="flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm text-sidebar-foreground hover:bg-sidebar-accent transition-colors">
          <Settings className="h-4 w-4" />
          <span>Settings</span>
        </button>
      </div>
    </aside>
  );
}
