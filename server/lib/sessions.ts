import fs from "node:fs/promises";
import path from "node:path";

export interface SessionState {
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

function storagePaths(projectPath: string) {
  const base = path.join(projectPath, ".coding-agent");
  return {
    sessions: path.join(base, "sessions"),
    events: path.join(base, "events"),
  };
}

export async function getSessions(
  projectPath: string
): Promise<SessionState[]> {
  const dir = storagePaths(projectPath).sessions;
  try {
    const files = await fs.readdir(dir);
    const sessions: SessionState[] = [];
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      const content = await fs.readFile(path.join(dir, file), "utf-8");
      sessions.push(JSON.parse(content) as SessionState);
    }
    sessions.sort(
      (a, b) =>
        new Date(b.lastActiveAt).getTime() - new Date(a.lastActiveAt).getTime()
    );
    return sessions;
  } catch {
    return [];
  }
}

export async function getSession(
  projectPath: string,
  sessionId: string
): Promise<SessionState | null> {
  const filePath = path.join(
    storagePaths(projectPath).sessions,
    `${sessionId}.json`
  );
  try {
    const content = await fs.readFile(filePath, "utf-8");
    return JSON.parse(content) as SessionState;
  } catch {
    return null;
  }
}

export async function getEvents(
  projectPath: string,
  sessionId: string
): Promise<AgentEvent[]> {
  const filePath = path.join(
    storagePaths(projectPath).events,
    `${sessionId}.jsonl`
  );
  try {
    const content = await fs.readFile(filePath, "utf-8");
    return content
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as AgentEvent);
  } catch {
    return [];
  }
}
