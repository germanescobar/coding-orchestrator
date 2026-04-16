import { Router } from "express";
import { randomUUID } from "node:crypto";
import { getProject } from "../lib/projects.js";
import { getSessions, getSession, getEvents, archiveSession, saveSession, appendEvent, type AgentEvent } from "../lib/sessions.js";
import { getApiKeyEnvVars } from "../lib/api-keys.js";
import { getAgentProvider, type AgentStreamEvent } from "../lib/agents.js";

// Strip ANSI escape codes (color, cursor, etc.)
const ANSI_RE = /\x1b\[[0-9;]*[a-zA-Z]/g;
function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "");
}

export const sessionsRouter = Router();

// Stream a new session via SSE — must be before /:sessionId routes
sessionsRouter.get("/:projectId/sessions/stream", async (req, res) => {
  const project = await getProject(req.params.projectId);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  const message = req.query.message as string;
  const resumeSessionId = req.query.resumeSessionId as string | undefined;
  const model = req.query.model as string | undefined;
  const providerId = (req.query.provider as string) || "ada";

  const provider = getAgentProvider(providerId);
  if (!provider) {
    res.status(400).json({ error: `Unknown agent provider: ${providerId}` });
    return;
  }

  if (!message) {
    res.status(400).json({ error: "message query param is required" });
    return;
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  const apiKeyEnv = await getApiKeyEnvVars();

  const child = provider.spawn({
    message,
    cwd: project.path,
    env: apiKeyEnv,
    resumeSessionId,
    model,
  });

  let stdoutBuffer = "";
  // For non-Ada providers, we persist events ourselves since they don't
  // write to .coding-agent/events/ like Ada does.
  const shouldPersist = providerId !== "ada";
  let streamSessionId = resumeSessionId ?? "";
  let userMessageWritten = false;

  // Close stdin so Codex doesn't wait for additional input
  if (providerId === "codex") {
    child.stdin?.end();
  }

  const projectPath = project.path;

  /** Write the user message + create session file once we know the sessionId. */
  async function persistSessionStart(sessionId: string) {
    streamSessionId = sessionId;
    // Write user message
    if (!userMessageWritten) {
      userMessageWritten = true;
      await appendEvent(projectPath, sessionId, {
        id: randomUUID(),
        sessionId,
        timestamp: new Date().toISOString(),
        type: "user_message",
        data: { text: message },
      });
    }
    // Create or update session file
    const title = message.length > 60 ? message.slice(0, 60) + "..." : message;
    await saveSession(projectPath, {
      id: sessionId,
      title,
      workingDirectory: projectPath,
      model: model ?? "",
      messages: [],
      createdAt: new Date().toISOString(),
      lastActiveAt: new Date().toISOString(),
      status: "active",
    });
  }

  /** Convert a normalized agent event to a persisted AgentEvent and append it. */
  function persistAgentEvent(event: AgentStreamEvent) {
    if (!streamSessionId) return;
    const agentEvent: AgentEvent = {
      id: randomUUID(),
      sessionId: streamSessionId,
      timestamp: new Date().toISOString(),
      type: event.type === "assistant.text" ? "assistant_response"
        : event.type === "assistant.reasoning" ? "assistant_reasoning"
        : event.type === "tool.call" ? "tool_call"
        : event.type === "tool.result" ? "tool_result"
        : event.type,
      data: event.type === "assistant.text" ? { content: [{ type: "text", text: (event as { text: string }).text }] }
        : event.type === "assistant.reasoning" ? { content: [{ type: "reasoning", text: (event as { text: string }).text }] }
        : event.type === "tool.call" ? { tool: (event as { name: string; input: unknown }).name, input: (event as { input: unknown }).input }
        : event.type === "tool.result" ? { tool: (event as { name: string; content: string; isError: boolean }).name, content: (event as { content: string }).content, isError: (event as { isError: boolean }).isError }
        : (event as Record<string, unknown>),
    };
    appendEvent(projectPath, streamSessionId, agentEvent).catch(() => {});
  }

  res.write(`data: ${JSON.stringify({ type: "started" })}\n\n`);

  // Forward stderr text and keep fallback approval handling for older prompts.
  child.stderr?.on("data", (data: Buffer) => {
    const raw = data.toString();
    const text = stripAnsi(raw).trim();

    // Filter out Codex's informational stdin message (but keep other content in the same chunk)
    const filtered = text
      .split("\n")
      .filter((line) => !line.includes("Reading additional input from stdin"))
      .join("\n")
      .trim();
    if (!filtered) return;

    res.write(`data: ${JSON.stringify({ type: "stderr", text: filtered })}\n\n`);

    if (raw.includes("[y/n]")) {
      child.stdin?.write("y\n");
    }
  });

  child.stdout?.on("data", (data: Buffer) => {
    const raw = data.toString();
    stdoutBuffer += raw;
    if (raw.includes("[y/n]")) {
      child.stdin?.write("y\n");
    }

    let newlineIndex = stdoutBuffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = stdoutBuffer.slice(0, newlineIndex).trim();
      stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);

      if (line.length > 0) {
        try {
          const event = provider.parseEvent(line);
          if (event) {
            // Persist events for non-Ada providers
            if (shouldPersist) {
              if (event.type === "run.started") {
                persistSessionStart(event.sessionId).catch(() => {});
              } else if (event.type !== "run.completed" && event.type !== "run.failed") {
                persistAgentEvent(event);
              }
            }
            res.write(
              `data: ${JSON.stringify({ type: "ada_event", event })}\n\n`
            );
          }
        } catch {
          res.write(
            `data: ${JSON.stringify({
              type: "error",
              text: `Failed to parse ${provider.name} stream JSON line.`,
              raw: line,
            })}\n\n`
          );
        }
      }

      newlineIndex = stdoutBuffer.indexOf("\n");
    }
  });

  child.on("close", (code) => {
    const lastLine = stdoutBuffer.trim();
    if (lastLine.length > 0) {
      try {
        const event = provider.parseEvent(lastLine);
        if (event) {
          if (shouldPersist && event.type !== "run.completed" && event.type !== "run.failed") {
            persistAgentEvent(event);
          }
          res.write(
            `data: ${JSON.stringify({ type: "ada_event", event })}\n\n`
          );
        }
      } catch {
        res.write(
          `data: ${JSON.stringify({
            type: "error",
            text: `Failed to parse final ${provider.name} stream JSON line.`,
            raw: lastLine,
          })}\n\n`
        );
      }
    }

    // Update session lastActiveAt (read existing to preserve title/createdAt)
    if (shouldPersist && streamSessionId) {
      getSession(projectPath, streamSessionId).then((existing) => {
        if (existing) {
          existing.lastActiveAt = new Date().toISOString();
          saveSession(projectPath, existing);
        }
      }).catch(() => {});
    }

    res.write(
      `data: ${JSON.stringify({ type: "done", exitCode: code })}\n\n`
    );
    res.end();
  });

  child.on("error", (err) => {
    res.write(
      `data: ${JSON.stringify({ type: "error", text: err.message })}\n\n`
    );
    res.end();
  });

  req.on("close", () => {
    child.kill();
  });
});

// Archive a session
sessionsRouter.post(
  "/:projectId/sessions/:sessionId/archive",
  async (req, res) => {
    const project = await getProject(req.params.projectId);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    const archived = await archiveSession(project.path, req.params.sessionId);
    if (!archived) {
      res.status(404).json({ error: "Session not found" });
      return;
    }
    res.json({ ok: true });
  }
);

// List sessions for a project
sessionsRouter.get("/:projectId/sessions", async (req, res) => {
  const project = await getProject(req.params.projectId);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  const sessions = await getSessions(project.path);
  res.json(sessions);
});

// Get a single session
sessionsRouter.get("/:projectId/sessions/:sessionId", async (req, res) => {
  const project = await getProject(req.params.projectId);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  const session = await getSession(project.path, req.params.sessionId);
  if (!session) {
    res.status(404).json({ error: "Session not found" });
    return;
  }
  res.json(session);
});

// Get events for a session
sessionsRouter.get(
  "/:projectId/sessions/:sessionId/events",
  async (req, res) => {
    const project = await getProject(req.params.projectId);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    const events = await getEvents(project.path, req.params.sessionId);
    res.json(events);
  }
);
