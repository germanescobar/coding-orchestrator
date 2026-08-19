import type { QueuedMessage, QueuedMessageInput } from "./session-queue.js";

export type CodexSteerResult =
  | { disposition: "steered" }
  | { disposition: "queued"; message?: QueuedMessage };

interface AcceptCodexSteerOptions {
  queuedMessageId?: string;
  steer: () => Promise<"steered" | "turn-ended">;
  steerQueuedMessage: (
    id: string
  ) => Promise<{
    message: QueuedMessage | null;
    outcome?: "steered" | "turn-ended";
  }>;
  buildFollowUp: () => Promise<QueuedMessageInput>;
  enqueueFollowUp: (input: QueuedMessageInput) => Promise<QueuedMessage>;
}

/*
 * Transfer ownership of a Codex composer submission exactly once. A terminal
 * event can win while turn/steer is in flight; in that case a typed message is
 * made durable, while a promoted queue item simply remains owned by the queue.
 */
export async function acceptCodexSteer(
  options: AcceptCodexSteerOptions
): Promise<CodexSteerResult> {
  if (options.queuedMessageId) {
    const resolution = await options.steerQueuedMessage(options.queuedMessageId);
    if (resolution.outcome === "steered") {
      return { disposition: "steered" };
    }
    return {
      disposition: "queued",
      message: resolution.message ?? undefined,
    };
  }

  const outcome = await options.steer();
  if (outcome === "steered") {
    return { disposition: "steered" };
  }

  const queued = await options.enqueueFollowUp(await options.buildFollowUp());
  return { disposition: "queued", message: queued };
}
