import { Router } from "express";
import { spawn } from "node:child_process";
import { getProject } from "../lib/projects.js";
import { getSessions, getSession, getEvents } from "../lib/sessions.js";

// Strip ANSI escape codes (color, cursor, etc.)
const ANSI_RE = /\x1b\[[0-9;]*[a-zA-Z]/g;
function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "");
}

type AdaStreamEvent =
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

  const cmdArgs: string[] = ["--stream-json", "--auto-approve"];
  if (model) {
    cmdArgs.push("--model", model);
  }

  const child = spawn("ada", [...cmdArgs, ...args], {
    cwd: project.path,
    env: { ...process.env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdoutBuffer = "";

  res.write(`data: ${JSON.stringify({ type: "started" })}\n\n`);

  // Forward stderr text and keep fallback approval handling for older prompts.
  child.stderr.on("data", (data: Buffer) => {
    const raw = data.toString();
    const text = stripAnsi(raw);
    res.write(`data: ${JSON.stringify({ type: "stderr", text })}\n\n`);

    if (raw.includes("[y/n]")) {
      child.stdin.write("y\n");
    }
  });

  child.stdout.on("data", (data: Buffer) => {
    const raw = data.toString();
    stdoutBuffer += raw;
    if (raw.includes("[y/n]")) {
      child.stdin.write("y\n");
    }

    let newlineIndex = stdoutBuffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = stdoutBuffer.slice(0, newlineIndex).trim();
      stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);

      if (line.length > 0) {
        try {
          const event = JSON.parse(line) as AdaStreamEvent;
          res.write(
            `data: ${JSON.stringify({ type: "ada_event", event })}\n\n`
          );
        } catch {
          res.write(
            `data: ${JSON.stringify({
              type: "error",
              text: "Failed to parse Ada stream JSON line.",
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
        const event = JSON.parse(lastLine) as AdaStreamEvent;
        res.write(`data: ${JSON.stringify({ type: "ada_event", event })}\n\n`);
      } catch {
        res.write(
          `data: ${JSON.stringify({
            type: "error",
            text: "Failed to parse final Ada stream JSON line.",
            raw: lastLine,
          })}\n\n`
        );
      }
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
