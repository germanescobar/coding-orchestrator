import { Router } from "express";
import { spawn } from "node:child_process";
import { getProject } from "../lib/projects.js";
import { getSessions, getSession, getEvents } from "../lib/sessions.js";

export const sessionsRouter = Router();

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

// Stream a new session via SSE (GET so EventSource can use it)
sessionsRouter.get("/:projectId/sessions/stream", async (req, res) => {
  const project = await getProject(req.params.projectId);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  const message = req.query.message as string;
  const resumeSessionId = req.query.resumeSessionId as string | undefined;

  if (!message) {
    res.status(400).json({ error: "message query param is required" });
    return;
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  const args = ["chat", message];
  if (resumeSessionId) {
    args.push("--resume", resumeSessionId);
  }

  const child = spawn("ada", args, {
    cwd: project.path,
    env: { ...process.env },
  });

  child.stdout.on("data", (data: Buffer) => {
    const text = data.toString();
    res.write(`data: ${JSON.stringify({ type: "stdout", text })}\n\n`);
  });

  child.stderr.on("data", (data: Buffer) => {
    const text = data.toString();
    res.write(`data: ${JSON.stringify({ type: "stderr", text })}\n\n`);
  });

  child.on("close", (code) => {
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
