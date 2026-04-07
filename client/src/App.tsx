import { useState } from "react";
import { ProjectList } from "./pages/ProjectList.tsx";
import { ProjectDetail } from "./pages/ProjectDetail.tsx";
import { SessionDetail } from "./pages/SessionDetail.tsx";

type Route =
  | { page: "projects" }
  | { page: "project"; projectId: string }
  | { page: "session"; projectId: string; sessionId: string };

export function App() {
  const [route, setRoute] = useState<Route>({ page: "projects" });

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100">
      <header className="border-b border-gray-800 px-6 py-4">
        <div className="flex items-center gap-4">
          <h1
            className="text-xl font-bold cursor-pointer hover:text-white"
            onClick={() => setRoute({ page: "projects" })}
          >
            Coding Orchestrator
          </h1>
          {route.page !== "projects" && (
            <>
              <span className="text-gray-600">/</span>
              <button
                className="text-gray-400 hover:text-white"
                onClick={() =>
                  setRoute({ page: "project", projectId: route.projectId })
                }
              >
                Project
              </button>
            </>
          )}
          {route.page === "session" && (
            <>
              <span className="text-gray-600">/</span>
              <span className="text-gray-400">Session</span>
            </>
          )}
        </div>
      </header>

      <main className="max-w-5xl mx-auto p-6">
        {route.page === "projects" && (
          <ProjectList
            onSelect={(id) => setRoute({ page: "project", projectId: id })}
          />
        )}
        {route.page === "project" && (
          <ProjectDetail
            projectId={route.projectId}
            onSelectSession={(sessionId) =>
              setRoute({
                page: "session",
                projectId: route.projectId,
                sessionId,
              })
            }
          />
        )}
        {route.page === "session" && (
          <SessionDetail
            projectId={route.projectId}
            sessionId={route.sessionId}
          />
        )}
      </main>
    </div>
  );
}
