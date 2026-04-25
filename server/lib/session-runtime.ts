interface SessionRuntimeState {
  active: boolean;
}

const runtimes = new Map<string, SessionRuntimeState>();

export function markSessionActive(sessionId: string) {
  runtimes.set(sessionId, { active: true });
}

export function markSessionInactive(sessionId: string) {
  runtimes.set(sessionId, { active: false });
}

export function getSessionRuntime(sessionId: string): SessionRuntimeState {
  return runtimes.get(sessionId) ?? { active: false };
}
