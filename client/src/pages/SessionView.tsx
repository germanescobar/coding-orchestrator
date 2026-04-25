import { useState, useEffect, useRef } from "react";
import { ArrowUp, Loader2, Copy, Check, ChevronDown, ChevronRight, TerminalSquare, MessageSquare } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Terminal, type TerminalHandle } from "@/components/terminal";
import { TerminalMobileControls } from "@/components/terminal-mobile-controls";
import {
  fetchEvents,
  fetchModels,
  fetchAgentProviders,
  fetchSession,
  fetchSessionRuntime,
  startSession,
  submitSessionUserInput,
  type Project,
  type AgentEvent,
  type AgentProviderInfo,
  type Model,
  type PlanStep,
  type SessionStreamEvent,
  type UserInputQuestion,
} from "../api.ts";

interface SessionViewProps {
  projectId: string;
  sessionId?: string;
  project?: Project;
  onSessionCreated: (sessionId: string) => void;
  onBackgroundComplete?: (sessionId: string) => void;
}

type StreamItem =
  | { type: "assistant"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "tool_call"; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; name?: string; content: string; isError: boolean }
  | { type: "plan_updated"; explanation: string | null; plan: PlanStep[] }
  | { type: "plan_delta"; id: string; delta: string }
  | { type: "user_input_requested"; id: string; questions: UserInputQuestion[] }
  | { type: "thread_status"; status: string; activeFlags: string[] }
  | { type: "error"; text: string };

function normalizeToolResultContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (content == null) return "";

  try {
    return JSON.stringify(content, null, 2);
  } catch {
    return String(content);
  }
}

function getRunStatusText(
  stopReason: "completed" | "max_iterations" | string,
  status: "completed" | "max_iterations"
) {
  if (status === "max_iterations" || stopReason === "max_turns") {
    return "Paused after a long run. You can keep going with a follow-up message.";
  }

  return "Done.";
}

function getLatestPendingUserInputRequest(
  events: AgentEvent[]
): UserInputQuestion[] | null {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event.type === "user_input_response") return null;
    if (event.type === "user_input_requested") {
      const questions =
        ((event.data.questions as UserInputQuestion[] | undefined) ?? []).filter(
          Boolean
        );
      return questions.length > 0 ? questions : null;
    }
  }

  return null;
}

function hasMatchingPersistedUserMessage(
  events: AgentEvent[],
  pendingMessage: string | null
): boolean {
  if (!pendingMessage) return false;

  return events.some(
    (event) =>
      event.type === "user_message" &&
      typeof event.data.text === "string" &&
      event.data.text === pendingMessage
  );
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
    const reasoningText = content
      ?.filter((b) => b.type === "reasoning")
      .map((b) => b.text)
      .filter((text): text is string => Boolean(text))
      .join("\n");
    const text = content
      ?.filter((b) => b.type === "text")
      .map((b) => b.text)
      .filter((text): text is string => Boolean(text))
      .join("\n");
    if (!reasoningText && !text) return null;
    return (
      <div className="space-y-3">
        {reasoningText ? <ReasoningBlock text={reasoningText} /> : null}
        {text ? (
          <AssistantBlock text={text}>
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
          </AssistantBlock>
        ) : null}
      </div>
    );
  }

  if (
    event.type === "assistant_reasoning" ||
    event.type === "assistant.reasoning"
  ) {
    const text =
      (data.text as string | undefined) ??
      (data.content as string | undefined) ??
      "";
    if (!text) return null;
    return <ReasoningBlock text={text} />;
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
      <ToolCallBlock
        expanded={expanded}
        input={input}
        inputPreview={inputPreview}
        onToggle={() => setExpanded(!expanded)}
        tool={tool}
      />
    );
  }

  // tool_result: show truncated, expandable
  if (event.type === "tool_result") {
    const tool = data.tool as string | undefined;
    const content = normalizeToolResultContent(data.content);
    const isError = data.isError as boolean | undefined;
    if (!content) return null;
    const isLong = content.length > 200;
    return (
      <ToolResultBlock
        content={content}
        expanded={expanded}
        isError={isError ?? false}
        isLong={isLong}
        onToggle={() => setExpanded(!expanded)}
        tool={tool}
      />
    );
  }

  if (event.type === "plan_updated") {
    const explanation = (data.explanation as string | null | undefined) ?? null;
    const plan = ((data.plan as PlanStep[] | undefined) ?? []).filter(Boolean);
    return <PlanUpdatedBlock explanation={explanation} plan={plan} />;
  }

  if (event.type === "plan_delta") {
    return null;
  }

  if (event.type === "user_input_requested") {
    const questions = ((data.questions as UserInputQuestion[] | undefined) ?? []).filter(Boolean);
    if (questions.length === 0) return null;
    return <UserInputRequestedBlock questions={questions} />;
  }

  if (event.type === "thread_status") {
    return null;
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
    return <ErrorBlock text={msg} />;
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

function AssistantBlock({
  text,
  children,
}: {
  text: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="space-y-2">
      <div className="prose prose-invert prose-sm max-w-none overflow-x-auto break-words">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
      </div>
      {children}
    </div>
  );
}

function ReasoningBlock({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const preview = text.replace(/\s+/g, " ").trim();

  return (
    <div className="rounded-lg border border-border/70 bg-card/60 overflow-hidden">
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
          <span className="text-sky-400">reasoning</span>
        </Badge>
        {!expanded && preview && (
          <span className="truncate text-xs text-muted-foreground">
            {preview.slice(0, 120)}
            {preview.length > 120 ? "..." : ""}
          </span>
        )}
      </button>
      {expanded && (
        <div className="border-t border-border px-4 py-3">
          <div className="prose prose-invert prose-sm max-w-none overflow-x-auto break-words text-muted-foreground">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
          </div>
        </div>
      )}
    </div>
  );
}

function ToolCallBlock({
  expanded,
  input,
  inputPreview,
  onToggle,
  tool,
}: {
  expanded: boolean;
  input?: Record<string, unknown>;
  inputPreview: string;
  onToggle: () => void;
  tool: string;
}) {
  return (
    <div className="rounded-lg border border-border bg-card overflow-hidden">
      <button
        onClick={onToggle}
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

function ToolResultBlock({
  content,
  expanded,
  isError,
  isLong,
  onToggle,
  tool,
}: {
  content: string;
  expanded: boolean;
  isError: boolean;
  isLong: boolean;
  onToggle: () => void;
  tool?: string;
}) {
  return (
    <div className="rounded-lg border border-border bg-card overflow-hidden">
      <button
        onClick={onToggle}
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

function PlanUpdatedBlock({
  explanation,
  plan,
}: {
  explanation: string | null;
  plan: PlanStep[];
}) {
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="flex items-center gap-2">
        <Badge variant="secondary" className="text-[10px]">
          <span className="text-emerald-400">plan</span>
        </Badge>
        <span className="text-xs text-muted-foreground">
          {plan.length} step{plan.length === 1 ? "" : "s"}
        </span>
      </div>
      {explanation ? (
        <p className="mt-3 text-sm text-muted-foreground">{explanation}</p>
      ) : null}
      <div className="mt-3 space-y-2">
        {plan.map((item, index) => (
          <div
            key={`${item.step}-${index}`}
            className="flex items-start gap-3 rounded-md border border-border/70 px-3 py-2"
          >
            <Badge
              variant="secondary"
              className="mt-0.5 shrink-0 text-[10px] uppercase"
            >
              {item.status.replace("_", " ")}
            </Badge>
            <span className="text-sm text-foreground">{item.step}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function UserInputRequestedBlock({
  answers,
  questions,
  onAnswerSelect,
  onSubmit,
  submitting = false,
}: {
  answers?: Record<string, string>;
  questions: UserInputQuestion[];
  onAnswerSelect?: (questionId: string, answer: string) => void;
  onSubmit?: () => void;
  submitting?: boolean;
}) {
  const allAnswered = questions.every((question) => Boolean(answers?.[question.id]));

  return (
    <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-4">
      <div className="flex items-center gap-2">
        <Badge variant="secondary" className="text-[10px]">
          <span className="text-amber-400">waiting</span>
        </Badge>
        <span className="text-sm text-foreground">Codex requested user input</span>
      </div>
      <div className="mt-3 space-y-3">
        {questions.map((question) => (
          <div key={question.id} className="rounded-md border border-border/70 p-3">
            <div className="text-xs uppercase tracking-wide text-muted-foreground">
              {question.header}
            </div>
            <div className="mt-1 text-sm text-foreground">{question.question}</div>
            <div className="mt-2 space-y-2">
              {question.options.map((option) => (
                <button
                  key={`${question.id}-${option.label}`}
                  type="button"
                  onClick={() => onAnswerSelect?.(question.id, option.label)}
                  disabled={!onAnswerSelect || submitting}
                  className={`w-full rounded-md px-3 py-2 text-left transition-colors ${
                    answers?.[question.id] === option.label
                      ? "bg-accent text-accent-foreground"
                      : "bg-background/70"
                  } ${onAnswerSelect ? "hover:bg-accent/70" : "cursor-default"}`}
                >
                  <div className="text-sm text-foreground">{option.label}</div>
                  <div className="text-xs text-muted-foreground">
                    {option.description}
                  </div>
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
      {onSubmit ? (
        <div className="mt-4 flex justify-end">
          <Button
            type="button"
            size="sm"
            onClick={onSubmit}
            disabled={!allAnswered || submitting}
          >
            {submitting ? "Submitting..." : "Continue"}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function ThreadStatusBlock({
  status,
  activeFlags,
}: {
  status: string;
  activeFlags: string[];
}) {
  return (
    <div className="rounded-lg border border-border bg-card p-3">
      <div className="flex items-center gap-2">
        <Badge variant="secondary" className="text-[10px]">
          <span className="text-cyan-400">thread</span>
        </Badge>
        <span className="text-sm text-foreground">{status}</span>
      </div>
      {activeFlags.length > 0 ? (
        <div className="mt-2 flex flex-wrap gap-2">
          {activeFlags.map((flag) => (
            <Badge key={flag} variant="secondary" className="text-[10px]">
              {flag}
            </Badge>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function ErrorBlock({ text }: { text: string }) {
  return (
    <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-3">
      <div className="flex items-center gap-2">
        <Badge variant="destructive" className="shrink-0 text-[10px]">
          error
        </Badge>
        <span className="text-xs text-destructive-foreground">{text}</span>
      </div>
    </div>
  );
}

export function SessionView({
  projectId,
  sessionId,
  project,
  onSessionCreated,
  onBackgroundComplete,
}: SessionViewProps) {
  const [message, setMessage] = useState("");
  const [pendingMessage, setPendingMessage] = useState<string | null>(null);
  const [streaming, setStreaming] = useState(false);
  const [streamItems, setStreamItems] = useState<StreamItem[]>([]);
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [models, setModels] = useState<Model[]>([]);
  const [selectedModel, setSelectedModel] = useState<string>("");
  const [selectedMode, setSelectedMode] = useState<"default" | "plan">("default");
  const [showModelPicker, setShowModelPicker] = useState(false);
  const [activeStreamSessionId, setActiveStreamSessionId] = useState<string | null>(sessionId ?? null);
  const [agentProviders, setAgentProviders] = useState<AgentProviderInfo[]>([]);
  const [selectedProvider, setSelectedProvider] = useState<string>("ada");
  const [providerResolved, setProviderResolved] = useState(!sessionId);
  const [showProviderPicker, setShowProviderPicker] = useState(false);
  const [terminalOpen, setTerminalOpen] = useState(true);
  const [mobilePanel, setMobilePanel] = useState<"agent" | "terminal">("agent");
  const [userInputDraft, setUserInputDraft] = useState<Record<string, string>>({});
  const [submittingUserInput, setSubmittingUserInput] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<TerminalHandle | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const modelPickerRef = useRef<HTMLDivElement>(null);
  const providerPickerRef = useRef<HTMLDivElement>(null);
  const eventSourceRef = useRef<EventSource | null>(null);
  const currentSessionIdRef = useRef(sessionId);
  const sendContextRef = useRef<{ sessionId: string | undefined; projectId: string } | null>(null);

  const attachToSession = (nextSessionId: string) => {
    setActiveStreamSessionId(nextSessionId);
    sendContextRef.current = { sessionId: nextSessionId, projectId };
    if (currentSessionIdRef.current !== nextSessionId) {
      onSessionCreated(nextSessionId);
    }
  };

  const loadModels = (provider?: string) => {
    fetchModels(provider ?? selectedProvider)
      .then((m) => {
        setModels(m);
        // Only reset to the first model if the current selection isn't in the list
        setSelectedModel((prev) => {
          if (prev && m.some((model) => model.id === prev)) return prev;
          return m.length > 0 ? m[0].id : "";
        });
      })
      .catch(() => {});
  };

  useEffect(() => {
    if (providerResolved) loadModels(selectedProvider);
  }, [selectedProvider, providerResolved]);

  useEffect(() => {
    if (selectedProvider !== "codex" && selectedMode !== "default") {
      setSelectedMode("default");
    }
  }, [selectedMode, selectedProvider]);

  useEffect(() => {
    fetchAgentProviders()
      .then((p) => setAgentProviders(p))
      .catch(() => {});
  }, []);

  // When loading an existing session, restore the provider and model that were used
  useEffect(() => {
    if (sessionId) {
      setProviderResolved(false);
      Promise.allSettled([
        fetchSession(projectId, sessionId),
        fetchEvents(projectId, sessionId),
        fetchSessionRuntime(projectId, sessionId),
      ])
        .then(([sessionResult, eventsResult, runtimeResult]) => {
          if (sessionResult.status === "fulfilled") {
            const session = sessionResult.value;
            setSelectedProvider(session.provider || "ada");
            setSelectedMode(session.mode || "default");
            if (session.model) {
              setSelectedModel(session.model);
            }
          }

          if (eventsResult.status === "fulfilled") {
            setEvents(eventsResult.value);
          }

          if (runtimeResult.status === "fulfilled") {
            setStreaming(runtimeResult.value.active);
          } else {
            setStreaming(false);
          }
        })
        .finally(() => setProviderResolved(true));
    } else {
      setEvents([]);
      setStreamItems([]);
      setStreaming(false);
      setProviderResolved(true);
      setSelectedMode("default");
    }
    setActiveStreamSessionId(sessionId ?? null);
    setUserInputDraft({});
  }, [projectId, sessionId]);

  useEffect(() => {
    if (!sessionId || eventSourceRef.current) return;
    if (!streaming) return;

    let cancelled = false;
    const interval = window.setInterval(async () => {
      try {
        const [evts, runtime] = await Promise.all([
          fetchEvents(projectId, sessionId),
          fetchSessionRuntime(projectId, sessionId),
        ]);
        if (cancelled) return;
        setEvents(evts);
        if (!runtime.active) {
          setStreaming(false);
          setPendingMessage(null);
          setStreamItems([]);
        }
      } catch {
        if (!cancelled) {
          setStreaming(false);
        }
      }
    }, 1500);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [projectId, sessionId, streaming]);

  // Track current session and manage stream visibility on session switch
  useEffect(() => {
    const prevSessionId = currentSessionIdRef.current;
    currentSessionIdRef.current = sessionId;

    if (eventSourceRef.current && sendContextRef.current) {
      if (sessionId !== sendContextRef.current.sessionId) {
        // Navigated away from the streaming session — hide streaming UI
        setStreaming(false);
        setPendingMessage(null);
        setStreamItems([]);
      } else if (prevSessionId !== sessionId) {
        // Navigated back to the streaming session — restore indicator
        setStreaming(true);
      }
    }
  }, [sessionId]);

  // Cleanup EventSource on unmount
  useEffect(() => {
    return () => {
      eventSourceRef.current?.close();
    };
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [events, streamItems]);

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (
        modelPickerRef.current &&
        !modelPickerRef.current.contains(e.target as Node)
      ) {
        setShowModelPicker(false);
      }
      if (
        providerPickerRef.current &&
        !providerPickerRef.current.contains(e.target as Node)
      ) {
        setShowProviderPicker(false);
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
    setStreamItems([]);
    let detectedSessionId = sessionId;
    let runFailed = false;

    // Track which session this stream belongs to
    sendContextRef.current = { sessionId, projectId };

    const es = startSession(projectId, sentMessage, {
      resumeSessionId: sessionId,
      model: selectedModel,
      provider: selectedProvider || undefined,
      mode: selectedProvider === "codex" ? selectedMode : "default",
    });
    eventSourceRef.current = es;

    // Check if the user is still viewing the session this stream belongs to
    const isVisible = () =>
      currentSessionIdRef.current == null ||
      currentSessionIdRef.current === sendContextRef.current?.sessionId;

    es.onmessage = (event) => {
      const data = JSON.parse(event.data) as SessionStreamEvent;
      if (data.type === "started" || data.type === "stderr") {
        if (data.type === "stderr") {
          const text = data.text.trim();
          if (text && isVisible()) {
            setStreamItems((prev) => [...prev, { type: "error", text }]);
          }
        }
      } else if (data.type === "ada_event") {
        const adaEvent = data.event;
        if (adaEvent.type === "run.started") {
          detectedSessionId = adaEvent.sessionId;
          attachToSession(adaEvent.sessionId);
        } else if (adaEvent.type === "assistant.text") {
          if (adaEvent.text && isVisible()) {
            setStreamItems((prev) => [
              ...prev,
              { type: "assistant", text: adaEvent.text },
            ]);
          }
        } else if (adaEvent.type === "assistant.reasoning") {
          if (adaEvent.text && isVisible()) {
            setStreamItems((prev) => [
              ...prev,
              { type: "reasoning", text: adaEvent.text },
            ]);
          }
        } else if (adaEvent.type === "tool.call") {
          if (isVisible()) {
            setStreamItems((prev) => [
              ...prev,
              { type: "tool_call", name: adaEvent.name, input: adaEvent.input },
            ]);
          }
        } else if (adaEvent.type === "tool.result") {
          if (isVisible()) {
            const content = normalizeToolResultContent(adaEvent.content);
            setStreamItems((prev) => [
              ...prev,
              {
                type: "tool_result",
                name: adaEvent.name,
                content,
                isError: adaEvent.isError,
              },
            ]);
          }
        } else if (adaEvent.type === "plan.updated") {
          if (isVisible()) {
            setStreamItems((prev) => [
              ...prev,
              {
                type: "plan_updated",
                explanation: adaEvent.explanation,
                plan: adaEvent.plan,
              },
            ]);
          }
        } else if (adaEvent.type === "plan.delta") {
          if (isVisible()) {
            setStreamItems((prev) => {
              const lastItem = prev[prev.length - 1];
              if (
                lastItem?.type === "plan_delta" &&
                lastItem.id === adaEvent.id
              ) {
                return [
                  ...prev.slice(0, -1),
                  {
                    type: "plan_delta",
                    id: adaEvent.id,
                    delta: `${lastItem.delta}${adaEvent.delta}`,
                  },
                ];
              }

              return [
                ...prev,
                {
                  type: "plan_delta",
                  id: adaEvent.id,
                  delta: adaEvent.delta,
                },
              ];
            });
          }
        } else if (adaEvent.type === "user.input_requested") {
          setUserInputDraft({});
          if (isVisible()) {
            setStreamItems((prev) => [
              ...prev,
              {
                type: "user_input_requested",
                id: adaEvent.id,
                questions: adaEvent.questions,
              },
            ]);
          }
        } else if (adaEvent.type === "thread.status") {
          // Thread status changes are useful internally, but they're noisy in
          // the visible transcript when there's no actionable information.
        } else if (adaEvent.type === "run.failed") {
          runFailed = true;
          if (isVisible()) {
            setStreamItems((prev) => [
              ...prev,
              { type: "error", text: adaEvent.error },
            ]);
          }
        } else if (adaEvent.type === "run.completed") {
          if (adaEvent.sessionId) detectedSessionId = adaEvent.sessionId;
          if ((adaEvent.status === "max_iterations" || adaEvent.stopReason === "max_turns") && isVisible()) {
            setStreamItems((prev) => [
              ...prev,
              {
                type: "error",
                text: getRunStatusText(adaEvent.stopReason, adaEvent.status),
              },
            ]);
          }
        }
      } else if (data.type === "done") {
        es.close();
        eventSourceRef.current = null;
        const wasVisible = isVisible();
        sendContextRef.current = null;

        if (wasVisible) {
          setStreaming(false);
          setPendingMessage(null);
          setActiveStreamSessionId(detectedSessionId || null);
          if (detectedSessionId) {
            fetchEvents(projectId, detectedSessionId)
              .then((evts) => {
                setEvents(evts);
                if (evts.length > 0 && !runFailed && (data.exitCode ?? 1) === 0) {
                  setStreamItems([]);
                }
              })
              .catch(() => {});
          }
        } else {
          // Stream completed while user was viewing another session
          if (detectedSessionId && onBackgroundComplete) {
            onBackgroundComplete(detectedSessionId);
          }
        }
      } else if (data.type === "error") {
        const text = data.text.trim();
        es.close();
        eventSourceRef.current = null;
        const wasVisible = isVisible();
        sendContextRef.current = null;
        if (wasVisible) {
          setStreamItems((prev) => [...prev, { type: "error", text }]);
          setStreaming(false);
          setPendingMessage(null);
        }
      }
    };

    es.onerror = () => {
      const wasVisible = isVisible();
      es.close();
      eventSourceRef.current = null;
      sendContextRef.current = null;
      if (wasVisible) {
        setStreaming(false);
        setPendingMessage(null);
      }
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

  const handleStructuredUserInputSubmit = async (
    questions: UserInputQuestion[]
  ) => {
    const targetSessionId = activeStreamSessionId ?? sessionId;
    if (!targetSessionId) return;

    const answers = Object.fromEntries(
      questions.map((question) => [question.id, userInputDraft[question.id]])
    );

    setSubmittingUserInput(true);
    try {
      await submitSessionUserInput(projectId, targetSessionId, answers);
      setUserInputDraft({});
    } catch (error) {
      setStreamItems((prev) => [
        ...prev,
        {
          type: "error",
          text: error instanceof Error ? error.message : "Failed to submit user input",
        },
      ]);
    } finally {
      setSubmittingUserInput(false);
    }
  };

  const selectedModelName =
    models.find((m) => m.id === selectedModel)?.name ?? selectedModel;
  const latestStructuredInputRequestFromStream =
    [...streamItems]
      .reverse()
      .find(
        (item): item is Extract<StreamItem, { type: "user_input_requested" }> =>
          item.type === "user_input_requested"
      ) ?? null;
  const latestStructuredInputRequest =
    latestStructuredInputRequestFromStream
      ? latestStructuredInputRequestFromStream
      : (() => {
          const questions = getLatestPendingUserInputRequest(events);
          return questions
            ? {
                type: "user_input_requested" as const,
                id: "persisted-user-input-request",
                questions,
              }
            : null;
        })();
  const showPendingMessage = !hasMatchingPersistedUserMessage(
    events,
    pendingMessage
  );

  return (
    <>
      {/* Header */}
      <header className="flex h-12 md:h-14 shrink-0 items-center justify-between border-b border-border bg-background px-3 md:px-4">
        <div className="flex items-center gap-2 md:gap-3 min-w-0">
          <h1 className="text-sm font-medium truncate">
            {project?.name ?? "Project"}
          </h1>
        </div>

        {/* Mobile: Agent/Terminal tabs in header */}
        {sessionId && (
          <div className="flex items-center gap-1 md:hidden">
            <button
              onClick={() => setMobilePanel("agent")}
              className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                mobilePanel === "agent"
                  ? "bg-accent text-foreground"
                  : "text-muted-foreground"
              }`}
            >
              <MessageSquare className="h-3 w-3" />
              Agent
            </button>
            <button
              onClick={() => setMobilePanel("terminal")}
              className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                mobilePanel === "terminal"
                  ? "bg-accent text-foreground"
                  : "text-muted-foreground"
              }`}
            >
              <TerminalSquare className="h-3 w-3" />
              Terminal
            </button>
          </div>
        )}

        {/* Desktop: path + terminal toggle */}
        <div className="hidden md:flex items-center gap-2">
          {project && (
            <span className="font-mono text-xs text-muted-foreground truncate max-w-64">
              {project.path}
            </span>
          )}
          {sessionId && (
            <button
              onClick={() => setTerminalOpen(!terminalOpen)}
              className={`ml-2 rounded-md p-1.5 transition-colors ${
                terminalOpen
                  ? "bg-accent text-foreground"
                  : "text-muted-foreground hover:bg-accent hover:text-foreground"
              }`}
              title={terminalOpen ? "Hide terminal" : "Show terminal"}
            >
              <TerminalSquare className="h-4 w-4" />
            </button>
          )}
        </div>
      </header>

      {/* Main content area: chat + terminal side by side on desktop, tabbed on mobile */}
      <div className="flex flex-1 min-h-0">
        {/* Chat panel — hidden on mobile when terminal tab is active */}
        <div className={`flex-col min-h-0 min-w-0 w-full ${
          sessionId && mobilePanel === "terminal" ? "hidden md:flex" : "flex"
        } ${sessionId && terminalOpen ? "md:w-1/2 md:border-r md:border-border" : "flex-1"}`}>
          {/* Messages / Events area */}
          <div className="flex-1 overflow-y-auto min-h-0">
            <div className="mx-auto max-w-3xl px-3 py-4 md:px-4 md:py-6">
              {!sessionId && events.length === 0 && streamItems.length === 0 && (
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
              {pendingMessage && showPendingMessage && (
                <div className="flex justify-end mt-4">
                  <div className="max-w-[85%] rounded-2xl bg-secondary px-4 py-3 text-sm">
                    {pendingMessage}
                  </div>
                </div>
              )}

              {/* Stream output */}
              {streamItems.length > 0 && (
                <div className="mt-4 space-y-3">
                  {streamItems.map((item, i) => {
                    if (item.type === "assistant") {
                      return <AssistantBlock key={i} text={item.text} />;
                    }

                    if (item.type === "reasoning") {
                      return <ReasoningBlock key={i} text={item.text} />;
                    }

                    if (item.type === "tool_call") {
                      const inputPreview = Object.entries(item.input)
                        .map(([k, v]) => {
                          const val = typeof v === "string" ? v : JSON.stringify(v);
                          return `${k}: ${val.length > 60 ? val.slice(0, 60) + "..." : val}`;
                        })
                        .join(", ");

                      return (
                        <LiveToolCallBlock
                          key={i}
                          input={item.input}
                          inputPreview={inputPreview}
                          tool={item.name}
                        />
                      );
                    }

                    if (item.type === "tool_result") {
                      return (
                        <LiveToolResultBlock
                          key={i}
                          content={item.content}
                          isError={item.isError}
                          tool={item.name}
                        />
                      );
                    }

                    if (item.type === "plan_updated") {
                      return (
                        <PlanUpdatedBlock
                          key={i}
                          explanation={item.explanation}
                          plan={item.plan}
                        />
                      );
                    }

                    if (item.type === "plan_delta") {
                      return (
                        <div
                          key={i}
                          className="rounded-lg border border-border bg-card/70 px-4 py-3 text-sm text-muted-foreground"
                        >
                          {item.delta}
                        </div>
                      );
                    }

                    if (item.type === "user_input_requested") {
                      return (
                        <UserInputRequestedBlock
                          key={i}
                          answers={
                            latestStructuredInputRequest?.id === item.id
                              ? userInputDraft
                              : undefined
                          }
                          questions={item.questions}
                          onAnswerSelect={
                            latestStructuredInputRequest?.id === item.id
                              ? (questionId, answer) =>
                                  setUserInputDraft((prev) => ({
                                    ...prev,
                                    [questionId]: answer,
                                  }))
                              : undefined
                          }
                          onSubmit={
                            latestStructuredInputRequest?.id === item.id
                              ? () => handleStructuredUserInputSubmit(item.questions)
                              : undefined
                          }
                          submitting={submittingUserInput}
                        />
                      );
                    }

                    if (item.type === "thread_status") {
                      return null;
                    }

                    if (item.type === "error") {
                      return <ErrorBlock key={i} text={item.text} />;
                    }

                    return null;
                  })}
                </div>
              )}

              {streamItems.length === 0 && latestStructuredInputRequest && (
                <div className="mt-4">
                  <UserInputRequestedBlock
                    answers={userInputDraft}
                    questions={latestStructuredInputRequest.questions}
                    onAnswerSelect={(questionId, answer) =>
                      setUserInputDraft((prev) => ({
                        ...prev,
                        [questionId]: answer,
                      }))
                    }
                    onSubmit={() =>
                      handleStructuredUserInputSubmit(
                        latestStructuredInputRequest.questions
                      )
                    }
                    submitting={submittingUserInput}
                  />
                </div>
              )}

              {streaming && (
                <div className="mt-4 flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  <span>Working...</span>
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
                      {/* Agent provider picker */}
                      <div className="relative" ref={providerPickerRef}>
                        <button
                          type="button"
                          onClick={() => !sessionId && setShowProviderPicker(!showProviderPicker)}
                          disabled={!!sessionId}
                          className={`flex items-center gap-1 rounded-md px-2 py-1 text-sm text-muted-foreground transition-colors ${
                            sessionId ? "opacity-50 cursor-not-allowed" : "hover:bg-accent hover:text-foreground"
                          }`}
                        >
                          {agentProviders.find((p) => p.id === selectedProvider)?.name ?? selectedProvider}
                          {!sessionId && <ChevronDown className="h-3 w-3" />}
                        </button>
                        {showProviderPicker && (
                          <div className="absolute bottom-full left-0 mb-1 w-40 rounded-lg border border-border bg-popover p-1 shadow-lg">
                            {agentProviders.map((p) => (
                              <button
                                key={p.id}
                                type="button"
                                onClick={() => {
                                  setSelectedProvider(p.id);
                                  setShowProviderPicker(false);
                                }}
                                className={`flex w-full items-center rounded-md px-3 py-2 text-sm text-left transition-colors ${
                                  selectedProvider === p.id
                                    ? "bg-accent text-accent-foreground"
                                    : "text-popover-foreground hover:bg-accent"
                                }`}
                              >
                                {p.name}
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                      <span className="text-muted-foreground/40">|</span>
                      {selectedProvider === "codex" && (
                        <>
                          <div className="flex items-center rounded-md border border-border bg-background/60 p-0.5">
                            <button
                              type="button"
                              onClick={() => setSelectedMode("default")}
                              disabled={streaming}
                              className={`rounded px-2 py-1 text-xs transition-colors ${
                                selectedMode === "default"
                                  ? "bg-accent text-accent-foreground"
                                  : "text-muted-foreground"
                              } ${streaming ? "cursor-not-allowed opacity-50" : ""}`}
                            >
                              Default
                            </button>
                            <button
                              type="button"
                              onClick={() => setSelectedMode("plan")}
                              disabled={streaming}
                              className={`rounded px-2 py-1 text-xs transition-colors ${
                                selectedMode === "plan"
                                  ? "bg-accent text-accent-foreground"
                                  : "text-muted-foreground"
                              } ${streaming ? "cursor-not-allowed opacity-50" : ""}`}
                            >
                              Plan
                            </button>
                          </div>
                          <span className="text-muted-foreground/40">|</span>
                        </>
                      )}
                      {/* Model picker */}
                      <div className="relative" ref={modelPickerRef}>
                        <button
                          type="button"
                          onClick={() => {
                            if (!showModelPicker && models.length === 0) loadModels(selectedProvider);
                            setShowModelPicker(!showModelPicker);
                          }}
                          className="flex items-center gap-1 rounded-md px-2 py-1 text-sm text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
                        >
                          {selectedModelName || "Select model"}
                          <ChevronDown className="h-3 w-3" />
                        </button>
                        {showModelPicker && (
                          <div className="absolute bottom-full left-0 mb-1 w-96 max-h-80 overflow-y-auto rounded-lg border border-border bg-popover p-1 shadow-lg">
                            {models.length === 0 ? (
                              <div className="px-3 py-2 text-xs text-muted-foreground">
                                No models found. Check ollama or add API keys in Settings.
                              </div>
                            ) : (
                              Object.entries(
                                models.reduce<Record<string, Model[]>>((acc, m) => {
                                  const provider = m.provider || "ollama";
                                  if (!acc[provider]) acc[provider] = [];
                                  acc[provider].push(m);
                                  return acc;
                                }, {})
                              ).map(([provider, providerModels]) => (
                                <div key={provider}>
                                  <div className="px-3 py-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                                    {provider}
                                  </div>
                                  {providerModels.map((model) => (
                                    <button
                                      key={model.id}
                                      type="button"
                                      onClick={() => {
                                        setSelectedModel(model.id);
                                        setShowModelPicker(false);
                                      }}
                                      className={`flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm text-left transition-colors ${
                                        selectedModel === model.id
                                          ? "bg-accent text-accent-foreground"
                                          : "text-popover-foreground hover:bg-accent"
                                      }`}
                                    >
                                      <span className="font-mono text-xs">{model.name}</span>
                                      {model.size && (
                                        <span className="ml-auto text-xs text-muted-foreground">
                                          {model.size}
                                        </span>
                                      )}
                                    </button>
                                  ))}
                                </div>
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
        </div>

        {/* Terminal panel — desktop: side panel; mobile: full screen when terminal tab active */}
        {sessionId && (terminalOpen || mobilePanel === "terminal") && (
          <div className={`flex flex-col min-h-0 min-w-0 overflow-hidden ${
            mobilePanel === "terminal" ? "flex-1 md:w-1/2" : "hidden md:flex md:w-1/2"
          }`}>
            <div className="hidden md:flex h-9 shrink-0 items-center justify-between border-b border-border bg-[#1c1c1e] px-3">
              <span className="text-xs font-medium text-muted-foreground">Terminal</span>
            </div>
            <div className="flex-1 min-h-0">
              <Terminal ref={terminalRef} sessionId={sessionId} projectId={projectId} />
            </div>
            <TerminalMobileControls terminalRef={terminalRef} />
          </div>
        )}
      </div>
    </>
  );
}

function LiveToolCallBlock({
  input,
  inputPreview,
  tool,
}: {
  input: Record<string, unknown>;
  inputPreview: string;
  tool: string;
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <ToolCallBlock
      expanded={expanded}
      input={input}
      inputPreview={inputPreview}
      onToggle={() => setExpanded(!expanded)}
      tool={tool}
    />
  );
}

function LiveToolResultBlock({
  content,
  isError,
  tool,
}: {
  content: string;
  isError: boolean;
  tool?: string;
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <ToolResultBlock
      content={content}
      expanded={expanded}
      isError={isError}
      isLong={content.length > 200}
      onToggle={() => setExpanded(!expanded)}
      tool={tool}
    />
  );
}
