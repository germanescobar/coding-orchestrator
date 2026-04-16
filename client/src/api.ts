const BASE = "/api";

export interface Project {
  id: string;
  name: string;
  path: string;
  createdAt: string;
}

export interface Session {
  id: string;
  title?: string;
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

export type AdaStreamEvent =
  | {
      type: "run.started";
      sessionId: string;
      model: string;
      workingDirectory: string;
      timestamp: string;
    }
  | {
      type: "assistant.text";
      text: string;
    }
  | {
      type: "assistant.reasoning";
      text: string;
    }
  | {
      type: "tool.call";
      id: string;
      name: string;
      input: Record<string, unknown>;
    }
  | {
      type: "tool.result";
      id: string;
      name: string;
      content: string;
      isError: boolean;
    }
  | {
      type: "run.completed";
      sessionId: string;
      status: "completed" | "max_iterations";
      stopReason: string;
      timestamp: string;
    }
  | {
      type: "run.failed";
      sessionId: string;
      error: string;
      timestamp: string;
    };

export type SessionStreamEvent =
  | { type: "started" }
  | { type: "ada_event"; event: AdaStreamEvent }
  | { type: "stderr"; text: string }
  | { type: "done"; exitCode: number | null }
  | { type: "error"; text: string; raw?: string };

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

export async function archiveSession(
  projectId: string,
  sessionId: string
): Promise<void> {
  await fetch(
    `${BASE}/projects/${projectId}/sessions/${sessionId}/archive`,
    { method: "POST" }
  );
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

export interface Model {
  id: string;
  name: string;
  provider: string;
  size: string;
}

export interface ProviderStatus {
  id: string;
  name: string;
  configured: boolean;
  hint: string | null;
}

export interface AgentProviderInfo {
  id: string;
  name: string;
}

export async function fetchAgentProviders(): Promise<AgentProviderInfo[]> {
  const res = await fetch(`${BASE}/agent-providers`);
  return res.json();
}

export async function fetchModels(agent?: string): Promise<Model[]> {
  const params = agent ? `?agent=${encodeURIComponent(agent)}` : "";
  const res = await fetch(`${BASE}/models${params}`);
  return res.json();
}

export async function fetchProviders(): Promise<ProviderStatus[]> {
  const res = await fetch(`${BASE}/api-keys`);
  return res.json();
}

export async function setProviderKey(
  providerId: string,
  key: string
): Promise<void> {
  await fetch(`${BASE}/api-keys/${providerId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key }),
  });
}

export async function deleteProviderKey(providerId: string): Promise<void> {
  await fetch(`${BASE}/api-keys/${providerId}`, { method: "DELETE" });
}

export function startSession(
  projectId: string,
  message: string,
  options?: { resumeSessionId?: string; model?: string; provider?: string }
): EventSource {
  const params = new URLSearchParams({ message });
  if (options?.resumeSessionId) params.set("resumeSessionId", options.resumeSessionId);
  if (options?.model) params.set("model", options.model);
  if (options?.provider) params.set("provider", options.provider);
  return new EventSource(
    `${BASE}/projects/${projectId}/sessions/stream?${params}`
  );
}
