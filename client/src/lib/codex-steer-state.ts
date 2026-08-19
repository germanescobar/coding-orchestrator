export type NativeSteerState = "unknown" | "active" | "terminal";

/* Unknown includes active turns observed only through polling. The server is
 * authoritative for those turns, so only an observed terminal SSE event
 * should bypass native steering and enqueue directly. */
export function shouldEnqueueCodexSteer(state: NativeSteerState): boolean {
  return state === "terminal";
}
