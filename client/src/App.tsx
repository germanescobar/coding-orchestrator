import { useState, useEffect, useCallback } from "react";
import { Menu, X } from "lucide-react";
import { toast } from "sonner";
import { fetchProjects, type Project } from "./api.ts";
import { Sidebar } from "./components/sidebar.tsx";
import { SettingsDialog } from "./components/settings-dialog.tsx";
import { ProjectSetup } from "./pages/ProjectSetup.tsx";
import { SessionView } from "./pages/SessionView.tsx";

export type View =
  | { page: "empty" }
  | { page: "new-project" }
  | { page: "session"; projectId: string; sessionId?: string };

function loadSavedView(): View {
  try {
    const saved = localStorage.getItem("activeView");
    if (saved) return JSON.parse(saved) as View;
  } catch {}
  return { page: "empty" };
}

export function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [view, setViewState] = useState<View>(loadSavedView);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(() => {
    const saved = loadSavedView();
    return saved.page === "session" ? saved.projectId : null;
  });
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [completedSessions, setCompletedSessions] = useState<Set<string>>(new Set());

  const setView = (v: View) => {
    setViewState(v);
    localStorage.setItem("activeView", JSON.stringify(v));
  };

  const loadProjects = useCallback(() => {
    fetchProjects().then(setProjects);
  }, []);

  useEffect(loadProjects, [loadProjects]);

  // Close sidebar on navigation (mobile)
  const closeSidebar = () => setSidebarOpen(false);

  const handleSelectProject = (projectId: string) => {
    setActiveProjectId(projectId);
    setView({ page: "session", projectId });
  };

  const handleSelectSession = (projectId: string, sessionId: string) => {
    setActiveProjectId(projectId);
    setView({ page: "session", projectId, sessionId });
    setCompletedSessions((prev) => {
      if (!prev.has(sessionId)) return prev;
      const next = new Set(prev);
      next.delete(sessionId);
      return next;
    });
    closeSidebar();
  };

  const handleNewThread = (projectId: string) => {
    setActiveProjectId(projectId);
    setView({ page: "session", projectId });
    closeSidebar();
  };

  const handleProjectCreated = () => {
    loadProjects();
    setView({ page: "empty" });
    closeSidebar();
  };

  return (
    <div className="dark flex h-dvh w-full bg-background text-foreground">
      {/* Mobile overlay */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-30 bg-black/50 md:hidden"
          onClick={closeSidebar}
        />
      )}

      {/* Sidebar */}
      <div
        className={`fixed inset-y-0 left-0 z-40 w-64 transform transition-transform duration-200 ease-in-out md:relative md:translate-x-0 ${
          sidebarOpen ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <Sidebar
          projects={projects}
          activeProjectId={activeProjectId}
          activeSessionId={view.page === "session" ? view.sessionId : undefined}
          completedSessions={completedSessions}
          onSelectProject={handleSelectProject}
          onSelectSession={handleSelectSession}
          onNewThread={handleNewThread}
          onNewProject={() => {
            setView({ page: "new-project" });
            closeSidebar();
          }}
          onProjectsChanged={loadProjects}
          onSettings={() => {
            setSettingsOpen(true);
            closeSidebar();
          }}
        />
      </div>

      <main className="flex flex-1 flex-col min-h-0 min-w-0">
        {/* Mobile header with hamburger */}
        <div className="flex h-12 shrink-0 items-center border-b border-border bg-background px-3 md:hidden">
          <button
            onClick={() => setSidebarOpen(!sidebarOpen)}
            className="rounded-md p-2 text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
          >
            {sidebarOpen ? (
              <X className="h-5 w-5" />
            ) : (
              <Menu className="h-5 w-5" />
            )}
          </button>
          <span className="ml-3 text-sm font-medium">
            Coding Orchestrator
          </span>
        </div>

        {view.page === "empty" && (
          <div className="flex flex-1 items-center justify-center p-4">
            <div className="text-center">
              <h2 className="text-lg font-medium text-muted-foreground">
                Select a project or create a new one
              </h2>
            </div>
          </div>
        )}

        {view.page === "new-project" && (
          <ProjectSetup
            onCreated={handleProjectCreated}
            onCancel={() => setView({ page: "empty" })}
          />
        )}

        {view.page === "session" && (
          <SessionView
            projectId={view.projectId}
            sessionId={view.sessionId}
            project={projects.find((p) => p.id === view.projectId)}
            onSessionCreated={(sessionId) => {
              setView({ page: "session", projectId: view.projectId, sessionId });
              loadProjects();
            }}
            onBackgroundComplete={(sessionId) => {
              setCompletedSessions((prev) => new Set(prev).add(sessionId));
              loadProjects();
              toast.success("Session completed", {
                description: "A background session has finished.",
                action: {
                  label: "View",
                  onClick: () => handleSelectSession(view.projectId, sessionId),
                },
              });
            }}
          />
        )}
      </main>

      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
    </div>
  );
}
