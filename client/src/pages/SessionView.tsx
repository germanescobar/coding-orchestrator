import { useState, useEffect, useRef } from "react";
import { ArrowUp, Loader2, Copy, Check, ChevronDown, ChevronRight } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  fetchEvents,
  fetchModels,
  startSession,
  type Project,
  type AgentEvent,
  type Model,
} from "../api.ts";

interface SessionViewProps {
  projectId: string;
  sessionId?: string;
  project?: Project;
  onSessionCreated: (sessionId: string) => void;
}

function EventBlock({
  event,
  copiedId,
  onCopy,
}: {
  event: AgentEvent;
  copiedId: string | null;
  onCopy: (e: AgentEvent) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const data = event.data;

  // user_message: show as chat bubble
  if (event.type === "user_message" && data.text) {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-2xl bg-secondary px-4 py-3 text-sm">
          {data.text as string}
        </div>
      </div>
    );
  }

  // assistant_response: render markdown
  if (event.type === "assistant_response") {
    const content = data.content as Array<{ type: string; text?: string }> | undefined;
    const text = content
      ?.filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n");
    if (!text) return null;
    return (
      <div className="space-y-2">
        <div className="prose prose-invert prose-sm max-w-none overflow-x-auto break-words">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
        </div>
        <button
          onClick={() => onCopy(event)}
          className="flex items-center gap-1 text-muted-foreground hover:text-foreground transition-colors"
        >
          {copiedId === event.id ? (
            <Check className="h-3.5 w-3.5" />
          ) : (
            <Copy className="h-3.5 w-3.5" />
          )}
        </button>
      </div>
    );
  }

  // tool_call: show tool name + input, expandable
  if (event.type === "tool_call") {
    const tool = data.tool as string | undefined;
    const input = data.input as Record<string, unknown> | undefined;
    if (!tool) return null;
    const inputPreview = input
      ? Object.entries(input)
          .map(([k, v]) => {
            const val = typeof v === "string" ? v : JSON.stringify(v);
            return `${k}: ${val.length > 60 ? val.slice(0, 60) + "..." : val}`;
          })
          .join(", ")
      : "";
    return (
      <div className="rounded-lg border border-border bg-card overflow-hidden">
        <button
          onClick={() => setExpanded(!expanded)}
          className="flex w-full items-center gap-2 p-3 text-left min-w-0"
        >
          {expanded ? (
            <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          )}
          <Badge variant="secondary" className="shrink-0 text-[10px]">
            <span className="text-yellow-400">tool_call</span>
          </Badge>
          <span className="font-mono text-xs text-foreground">{tool}</span>
          {!expanded && inputPreview && (
            <span className="truncate text-xs text-muted-foreground">
              {inputPreview}
            </span>
          )}
        </button>
        {expanded && input && (
          <pre className="border-t border-border px-4 py-3 text-xs text-muted-foreground font-mono whitespace-pre-wrap overflow-x-auto">
            {JSON.stringify(input, null, 2)}
          </pre>
        )}
      </div>
    );
  }

  // tool_result: show truncated, expandable
  if (event.type === "tool_result") {
    const tool = data.tool as string | undefined;
    const content = data.content as string | undefined;
    const isError = data.isError as boolean | undefined;
    if (!content) return null;
    const isLong = content.length > 200;
    return (
      <div className="rounded-lg border border-border bg-card overflow-hidden">
        <button
          onClick={() => setExpanded(!expanded)}
          className="flex w-full items-center gap-2 p-3 text-left min-w-0"
        >
          {expanded ? (
            <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          )}
          <Badge
            variant={isError ? "destructive" : "secondary"}
            className="shrink-0 text-[10px]"
          >
            <span className={isError ? "text-red-400" : "text-orange-400"}>
              tool_result
            </span>
          </Badge>
          {tool && (
            <span className="font-mono text-xs text-foreground">{tool}</span>
          )}
          {!expanded && (
            <span className="truncate text-xs text-muted-foreground">
              {content.slice(0, 120)}
              {isLong ? "..." : ""}
            </span>
          )}
        </button>
        {expanded && (
          <pre className="border-t border-border px-4 py-3 text-xs text-muted-foreground font-mono whitespace-pre-wrap overflow-x-auto max-h-96 overflow-y-auto">
            {content}
          </pre>
        )}
      </div>
    );
  }

  // policy_decision: show only if interesting (deny or ask)
  if (event.type === "policy_decision") {
    const decision = data.decision as string | undefined;
    if (decision === "allow") return null;
    const tool = data.tool as string | undefined;
    return (
      <div className="rounded-lg border border-border bg-card p-3">
        <div className="flex items-center gap-2">
          <Badge variant="secondary" className="shrink-0 text-[10px]">
            <span className="text-purple-400">policy</span>
          </Badge>
          <span className="text-xs text-muted-foreground">
            {tool}: <span className="font-medium text-foreground">{decision}</span>
          </span>
        </div>
      </div>
    );
  }

  // session_start / session_end: compact
  if (event.type === "session_start" || event.type === "session_end") {
    return (
      <div className="flex items-center gap-2 py-1">
        <div className="h-px flex-1 bg-border" />
        <span className="text-xs text-muted-foreground">{event.type.replace("_", " ")}</span>
        <div className="h-px flex-1 bg-border" />
      </div>
    );
  }

  // error
  if (event.type === "error") {
    const msg =
      (data.message as string) ?? (data.text as string) ?? JSON.stringify(data);
    return (
      <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-3">
        <div className="flex items-center gap-2">
          <Badge variant="destructive" className="shrink-0 text-[10px]">
            error
          </Badge>
          <span className="text-xs text-destructive-foreground">{msg}</span>
        </div>
      </div>
    );
  }

  // Fallback: generic expandable
  return (
    <div className="rounded-lg border border-border bg-card">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-2 p-3 text-left"
      >
        {expanded ? (
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        )}
        <Badge variant="secondary" className="shrink-0 text-[10px]">
          {event.type}
        </Badge>
      </button>
      {expanded && (
        <pre className="border-t border-border px-4 py-3 text-xs text-muted-foreground font-mono whitespace-pre-wrap overflow-x-auto">
          {JSON.stringify(data, null, 2)}
        </pre>
      )}
    </div>
  );
}

export function SessionView({
  projectId,
  sessionId,
  project,
  onSessionCreated,
}: SessionViewProps) {
  const [message, setMessage] = useState("");
  const [pendingMessage, setPendingMessage] = useState<string | null>(null);
  const [streaming, setStreaming] = useState(false);
  const [streamOutput, setStreamOutput] = useState<string[]>([]);
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [models, setModels] = useState<Model[]>([]);
  const [selectedModel, setSelectedModel] = useState<string>("");
  const [showModelPicker, setShowModelPicker] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const modelPickerRef = useRef<HTMLDivElement>(null);

  const loadModels = () => {
    fetchModels()
      .then((m) => {
        setModels(m);
        if (m.length > 0 && !selectedModel) {
          setSelectedModel(m[0].id);
        }
      })
      .catch(() => {});
  };

  useEffect(loadModels, []);

  useEffect(() => {
    if (sessionId) {
      fetchEvents(projectId, sessionId).then(setEvents);
    } else {
      setEvents([]);
    }
    setStreamOutput([]);
  }, [projectId, sessionId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [events, streamOutput]);

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (
        modelPickerRef.current &&
        !modelPickerRef.current.contains(e.target as Node)
      ) {
        setShowModelPicker(false);
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  const handleSend = (e: React.FormEvent) => {
    e.preventDefault();
    if (!message.trim() || streaming) return;

    const sentMessage = message;
    setMessage("");
    setPendingMessage(sentMessage);
    setStreaming(true);
    setStreamOutput([]);
    let detectedSessionId = sessionId;

    const es = startSession(projectId, sentMessage, {
      resumeSessionId: sessionId,
      model: selectedModel || undefined,
    });

    es.onmessage = (event) => {
      const data = JSON.parse(event.data);
      if (data.type === "stdout" || data.type === "stderr") {
        const text = data.text as string;
        setStreamOutput((prev) => [...prev, text]);

        // Parse session ID from ada output: "Session: <uuid>"
        if (!detectedSessionId) {
          const match = text.match(/Session:\s+([0-9a-f-]{36})/);
          if (match) {
            detectedSessionId = match[1];
          }
        }
      } else if (data.type === "done") {
        es.close();
        setStreaming(false);
        setStreamOutput([]);
        setPendingMessage(null);
        if (detectedSessionId) {
          // Fetch events directly, then navigate
          fetchEvents(projectId, detectedSessionId).then((evts) => {
            setEvents(evts);
            onSessionCreated(detectedSessionId!);
          });
        }
      } else if (data.type === "error") {
        setStreamOutput((prev) => [...prev, `Error: ${data.text}`]);
        es.close();
        setStreaming(false);
      }
    };

    es.onerror = () => {
      es.close();
      setStreaming(false);
    };
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend(e);
    }
  };

  const copyEventData = (event: AgentEvent) => {
    navigator.clipboard.writeText(JSON.stringify(event.data, null, 2));
    setCopiedId(event.id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  const selectedModelName =
    models.find((m) => m.id === selectedModel)?.name ?? selectedModel;

  return (
    <>
      {/* Header */}
      <header className="flex h-12 md:h-14 shrink-0 items-center justify-between border-b border-border bg-background px-3 md:px-4">
        <div className="flex items-center gap-2 md:gap-3 min-w-0">
          <h1 className="text-sm font-medium truncate">
            {project?.name ?? "Project"}
          </h1>
          {sessionId && (
            <span className="hidden sm:inline font-mono text-xs text-muted-foreground">
              {sessionId.slice(0, 8)}...
            </span>
          )}
          {streaming && (
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              <span className="hidden sm:inline">Running</span>
            </div>
          )}
        </div>
        <div className="hidden md:flex items-center gap-2">
          {project && (
            <span className="font-mono text-xs text-muted-foreground truncate max-w-64">
              {project.path}
            </span>
          )}
        </div>
      </header>

      {/* Messages / Events area */}
      <div className="flex-1 overflow-y-auto min-h-0">
        <div className="mx-auto max-w-3xl px-3 py-4 md:px-4 md:py-6">
          {!sessionId && events.length === 0 && streamOutput.length === 0 && (
            <div className="flex flex-col items-center justify-center py-20">
              <h2 className="text-lg font-medium text-muted-foreground">
                Start a new thread
              </h2>
              <p className="mt-1 text-sm text-muted-foreground/70">
                Send a message to begin working with the coding agent
              </p>
            </div>
          )}

          {/* Event timeline */}
          <div className="space-y-4">
            {events.map((event) => (
              <EventBlock
                key={event.id}
                event={event}
                copiedId={copiedId}
                onCopy={copyEventData}
              />
            ))}
          </div>

          {/* Pending user message */}
          {pendingMessage && (
            <div className="flex justify-end mt-4">
              <div className="max-w-[85%] rounded-2xl bg-secondary px-4 py-3 text-sm">
                {pendingMessage}
              </div>
            </div>
          )}

          {/* Stream output */}
          {streamOutput.length > 0 && (
            <div className="mt-4 rounded-lg border border-border bg-card p-4 font-mono text-sm whitespace-pre-wrap break-words overflow-x-auto text-muted-foreground">
              {streamOutput.map((line, i) => (
                <span key={i}>{line}</span>
              ))}
            </div>
          )}

          <div ref={bottomRef} />
        </div>
      </div>

      {/* Input */}
      <div className="shrink-0 border-t border-border bg-background px-3 pb-3 pt-2 md:px-4 md:pb-4 md:pt-3">
        <div className="mx-auto max-w-3xl">
          <form onSubmit={handleSend}>
            <div className="rounded-xl border border-border bg-input p-3">
              <textarea
                ref={textareaRef}
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={
                  sessionId
                    ? "Ask for follow-up changes"
                    : "Describe what you want to build..."
                }
                rows={1}
                disabled={streaming}
                className="w-full resize-none bg-transparent text-sm text-foreground placeholder:text-muted-foreground focus:outline-none disabled:opacity-50"
              />
              <div className="mt-2 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <div className="relative" ref={modelPickerRef}>
                    <button
                      type="button"
                      onClick={() => {
                        if (!showModelPicker && models.length === 0) loadModels();
                        setShowModelPicker(!showModelPicker);
                      }}
                      className="flex items-center gap-1 rounded-md px-2 py-1 text-sm text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
                    >
                      {selectedModelName || "Select model"}
                      <ChevronDown className="h-3 w-3" />
                    </button>
                    {showModelPicker && (
                      <div className="absolute bottom-full left-0 mb-1 w-64 rounded-lg border border-border bg-popover p-1 shadow-lg">
                        {models.length === 0 ? (
                          <div className="px-3 py-2 text-xs text-muted-foreground">
                            No models found (is ollama running?)
                          </div>
                        ) : (
                          models.map((model) => (
                            <button
                              key={model.id}
                              type="button"
                              onClick={() => {
                                setSelectedModel(model.id);
                                setShowModelPicker(false);
                              }}
                              className={`flex w-full items-center justify-between rounded-md px-3 py-2 text-sm transition-colors ${
                                selectedModel === model.id
                                  ? "bg-accent text-accent-foreground"
                                  : "text-popover-foreground hover:bg-accent"
                              }`}
                            >
                              <span className="font-mono">{model.name}</span>
                              <span className="text-xs text-muted-foreground">
                                {model.size}
                              </span>
                            </button>
                          ))
                        )}
                      </div>
                    )}
                  </div>
                </div>
                <Button
                  type="submit"
                  size="icon"
                  disabled={streaming || !message.trim()}
                  className="h-8 w-8 rounded-full bg-foreground text-background hover:bg-foreground/90"
                >
                  {streaming ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <ArrowUp className="h-4 w-4" />
                  )}
                </Button>
              </div>
            </div>
          </form>
        </div>
      </div>
    </>
  );
}
