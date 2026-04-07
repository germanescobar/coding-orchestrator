const BASE = "/api";

export interface Project {
  id: string;
  name: string;
  path: string;
  createdAt: string;
}

export interface Session {
  id: string;
  workingDirectory: string;
  model: string;
  messages: unknown[];
  createdAt: string;
  lastActiveAt: string;
  status: string;
}

export interface AgentEvent {
  id: string;
  sessionId: string;
  timestamp: string;
  type: string;
  data: Record<string, unknown>;
}

export async function fetchProjects(): Promise<Project[]> {
  const res = await fetch(`${BASE}/projects`);
  return res.json();
}

export async function createProject(
  name: string,
  path: string
): Promise<Project> {
  const res = await fetch(`${BASE}/projects`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, path }),
  });
  return res.json();
}

export async function deleteProject(id: string): Promise<void> {
  await fetch(`${BASE}/projects/${id}`, { method: "DELETE" });
}

export async function fetchSessions(projectId: string): Promise<Session[]> {
  const res = await fetch(`${BASE}/projects/${projectId}/sessions`);
  return res.json();
}

export async function fetchSession(
  projectId: string,
  sessionId: string
): Promise<Session> {
  const res = await fetch(
    `${BASE}/projects/${projectId}/sessions/${sessionId}`
  );
  return res.json();
}

export async function fetchEvents(
  projectId: string,
  sessionId: string
): Promise<AgentEvent[]> {
  const res = await fetch(
    `${BASE}/projects/${projectId}/sessions/${sessionId}/events`
  );
  return res.json();
}

export function startSession(
  projectId: string,
  message: string,
  resumeSessionId?: string
): EventSource {
  // We can't use EventSource with POST, so use fetch + ReadableStream
  // Instead, let's use a custom approach
  const params = new URLSearchParams({ message });
  if (resumeSessionId) params.set("resumeSessionId", resumeSessionId);

  const es = new EventSource(
    `${BASE}/projects/${projectId}/sessions/stream?${params}`
  );
  return es;
}
