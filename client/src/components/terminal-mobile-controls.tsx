import type { TerminalSpecialKey, TerminalHandle } from "./terminal";

interface TerminalMobileControlsProps {
  terminalRef: React.RefObject<TerminalHandle | null>;
  disabled?: boolean;
}

type MobileTerminalAction =
  | { id: string; label: string; title: string; kind: "focus" }
  | {
      id: TerminalSpecialKey;
      label: string;
      symbol?: string;
      title: string;
      kind: "input";
    };

// Type | Esc Tab ↵ ⌫ | ← ↑ ↓ → | ^C ^D
const MOBILE_TERMINAL_ACTION_GROUPS: MobileTerminalAction[][] = [
  [
    {
      id: "focus",
      label: "Type",
      title: "Focus the terminal keyboard",
      kind: "focus",
    },
  ],
  [
    { id: "escape", label: "Esc", title: "Send Escape", kind: "input" },
    { id: "tab", label: "Tab", title: "Send Tab", kind: "input" },
    {
      id: "enter",
      label: "Enter",
      symbol: "\u21b5",
      title: "Send Enter",
      kind: "input",
    },
    {
      id: "backspace",
      label: "Bksp",
      symbol: "\u232b",
      title: "Send Backspace",
      kind: "input",
    },
  ],
  [
    {
      id: "left",
      label: "Left",
      symbol: "\u2190",
      title: "Send Left Arrow",
      kind: "input",
    },
    {
      id: "up",
      label: "Up",
      symbol: "\u2191",
      title: "Send Up Arrow",
      kind: "input",
    },
    {
      id: "down",
      label: "Down",
      symbol: "\u2193",
      title: "Send Down Arrow",
      kind: "input",
    },
    {
      id: "right",
      label: "Right",
      symbol: "\u2192",
      title: "Send Right Arrow",
      kind: "input",
    },
  ],
  [
    {
      id: "ctrl-c",
      label: "Ctrl+C",
      symbol: "^C",
      title: "Send Ctrl+C",
      kind: "input",
    },
    {
      id: "ctrl-d",
      label: "Ctrl+D",
      symbol: "^D",
      title: "Send Ctrl+D",
      kind: "input",
    },
  ],
];

export function TerminalMobileControls({
  terminalRef,
  disabled = false,
}: TerminalMobileControlsProps) {
  const handleAction = (action: MobileTerminalAction) => {
    if (!terminalRef.current) return;
    if (action.kind === "focus") {
      terminalRef.current.focus();
      return;
    }
    terminalRef.current.sendSpecialKey(action.id);
  };

  return (
    <div className="terminal-mobile-controls shrink-0 border-t border-border bg-background/95 backdrop-blur-sm"
      style={{ paddingBottom: "calc(8px + env(safe-area-inset-bottom, 0px))" }}
    >
      <div
        style={{
          display: "flex",
          gap: 5,
          overflowX: "auto",
          WebkitOverflowScrolling: "touch",
          scrollbarWidth: "none",
          paddingTop: 6,
          paddingBottom: 2,
          alignItems: "center",
        }}
      >
        <div style={{ width: 12, flexShrink: 0 }} aria-hidden />
        {MOBILE_TERMINAL_ACTION_GROUPS.map((group, groupIndex) => (
          <div key={groupIndex} style={{ display: "flex", flexShrink: 0, alignItems: "center", gap: 4 }}>
            {groupIndex > 0 && (
              <div
                style={{ margin: "0 4px", height: 20, width: 1, flexShrink: 0, background: "var(--border)" }}
                aria-hidden
              />
            )}
            {group.map((action) => {
              const isFocus = action.kind === "focus";
              const display =
                "symbol" in action && action.symbol
                  ? action.symbol
                  : action.label;
              return (
                <button
                  key={action.id}
                  type="button"
                  disabled={disabled}
                  onPointerDown={(e) => {
                    e.preventDefault();
                    if (action.kind === "focus") {
                      handleAction(action);
                    }
                  }}
                  onClick={(e) => {
                    if (action.kind === "focus" && e.detail > 0) {
                      return;
                    }
                    handleAction(action);
                  }}
                  className={`terminal-key-btn shrink-0 select-none rounded-md font-medium transition-all active:scale-95 disabled:pointer-events-none disabled:opacity-35 ${
                    isFocus
                      ? "border border-primary/40 bg-primary/12 px-4 text-primary"
                      : "border border-border bg-card px-3 text-muted-foreground active:bg-accent active:text-foreground"
                  }`}
                  aria-label={action.title}
                  title={action.title}
                >
                  {display}
                </button>
              );
            })}
          </div>
        ))}
        <div style={{ width: 12, flexShrink: 0 }} aria-hidden />
      </div>
    </div>
  );
}
