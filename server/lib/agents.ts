import { spawn, type ChildProcess } from "node:child_process";

/**
 * Normalized stream event format used across all agent providers.
 * The UI only deals with these types.
 */
export type AgentStreamEvent =
  | {
      type: "run.started";
      sessionId: string;
      model: string;
      workingDirectory: string;
      timestamp: string;
    }
  | { type: "assistant.text"; text: string }
  | { type: "assistant.reasoning"; text: string }
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

export interface SpawnOptions {
  message: string;
  cwd: string;
  env: Record<string, string>;
  resumeSessionId?: string;
  model?: string;
}

export interface AgentProvider {
  id: string;
  name: string;
  spawn(opts: SpawnOptions): ChildProcess;
  parseEvent(line: string): AgentStreamEvent | null;
}

// ---------------------------------------------------------------------------
// Ada provider
// ---------------------------------------------------------------------------

const adaProvider: AgentProvider = {
  id: "ada",
  name: "Ada",

  spawn({ message, cwd, env, resumeSessionId, model }) {
    const cmdArgs = ["--stream-json", "--auto-approve", "--model", model || ""];

    const args = ["chat", message];
    if (resumeSessionId) args.push("--resume", resumeSessionId);

    const fullCmd = `ada ${[...cmdArgs, ...args].join(" ")}`;
    console.log(`[ada] ${fullCmd.slice(0, 100)}...`);

    return spawn("ada", [...cmdArgs, ...args], {
      cwd,
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
  },

  parseEvent(line: string): AgentStreamEvent | null {
    const event = JSON.parse(line);
    // Ada events already match our normalized format
    return event as AgentStreamEvent;
  },
};

// ---------------------------------------------------------------------------
// Codex provider
// ---------------------------------------------------------------------------

let codexThreadId = "";

const codexProvider: AgentProvider = {
  id: "codex",
  name: "Codex",

  spawn({ message, cwd, env, resumeSessionId, model }) {
    codexThreadId = "";
    // Flags must come before the prompt argument
    const flags = ["--json", "--full-auto", "--skip-git-repo-check", "--model", model || ""];

    let args: string[];
    if (resumeSessionId) {
      args = ["exec", ...flags, "resume", resumeSessionId, message];
    } else {
      args = ["exec", ...flags, message];
    }

    const fullCmd = `codex ${args.join(" ")}`;
    console.log(`[codex] ${fullCmd.slice(0, 100)}...`);

    return spawn("codex", args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
  },

  parseEvent(line: string): AgentStreamEvent | null {
    const event = JSON.parse(line);
    return mapCodexEvent(event);
  },
};

/**
 * Map a Codex JSONL event to our normalized AgentStreamEvent format.
 * Returns null for events we don't surface to the UI.
 */
function mapCodexEvent(event: Record<string, unknown>): AgentStreamEvent | null {
  const type = event.type as string;

  if (type === "thread.started") {
    codexThreadId = event.thread_id as string;
    return {
      type: "run.started",
      sessionId: codexThreadId,
      model: "",
      workingDirectory: "",
      timestamp: new Date().toISOString(),
    };
  }

  if (type === "item.completed" || type === "item.started") {
    const item = event.item as Record<string, unknown> | undefined;
    if (!item) return null;

    const itemType = item.type as string;
    const itemId = (item.id as string) ?? "";

    // Agent message (assistant text)
    if (itemType === "agent_message" && type === "item.completed") {
      const text = (item.text as string) ?? "";
      if (!text) return null;
      return { type: "assistant.text", text };
    }

    // Reasoning
    if (itemType === "reasoning" && type === "item.completed") {
      const text =
        (item.text as string) ??
        (item.content as string) ??
        "";
      if (!text) return null;
      return { type: "assistant.reasoning", text };
    }

    // Command execution / tool calls
    if (
      itemType === "command_execution" ||
      itemType === "mcp_call" ||
      itemType === "file_change" ||
      itemType === "web_search"
    ) {
      if (type === "item.started") {
        const name =
          (item.tool as string) ??
          (item.command as string) ??
          itemType;
        const input =
          (item.input as Record<string, unknown>) ??
          (item.args as Record<string, unknown>) ??
          {};
        return { type: "tool.call", id: itemId, name, input };
      }

      if (type === "item.completed") {
        const name =
          (item.tool as string) ??
          (item.command as string) ??
          itemType;
        const content =
          (item.aggregated_output as string) ??
          (item.output as string) ??
          (item.content as string) ??
          (item.result as string) ??
          JSON.stringify(item);
        const isError = (item.exit_code as number) !== 0 && item.exit_code != null;
        return { type: "tool.result", id: itemId, name, content, isError };
      }
    }

    return null;
  }

  if (type === "turn.completed") {
    return {
      type: "run.completed",
      sessionId: codexThreadId,
      status: "completed",
      stopReason: "completed",
      timestamp: new Date().toISOString(),
    };
  }

  if (type === "turn.failed" || type === "error") {
    const error =
      (event.error as string) ??
      (event.message as string) ??
      "Unknown error";
    return {
      type: "run.failed",
      sessionId: "",
      error,
      timestamp: new Date().toISOString(),
    };
  }

  // Ignore other event types (turn.started, etc.)
  return null;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const providers: Record<string, AgentProvider> = {
  ada: adaProvider,
  codex: codexProvider,
};

export function getAgentProvider(id: string): AgentProvider | undefined {
  return providers[id];
}

export function getAgentProviders(): AgentProvider[] {
  return Object.values(providers);
}
