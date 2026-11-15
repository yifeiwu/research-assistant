import type { TurnStatusData } from "@/lib/types/chat";

type ActiveTurnStatus = Exclude<TurnStatusData, { state: "clear" }>;

/**
 * The turn's current queue/rate-limit wait, if any. The server sends one
 * `data-turn-status` part per turn and replaces it in place, so the last one
 * in the message is the current state.
 */
export function activeTurnStatus(message: {
  parts: ReadonlyArray<{ type: string }>;
}): ActiveTurnStatus | null {
  for (let i = message.parts.length - 1; i >= 0; i--) {
    const part = message.parts[i] as { type: string; data?: TurnStatusData };
    if (part.type !== "data-turn-status") continue;
    const data = part.data;
    if (!data || data.state === "clear") return null;
    if (data.state === "queued" || data.state === "waiting") return data;
    return null;
  }
  return null;
}

const STAGE_ACTIVITY: Record<
  Extract<TurnStatusData, { state: "waiting" }>["stage"],
  string
> = {
  planning: "planning searches",
  reading: "reading sources",
  answering: "writing the answer",
};

/** Whole seconds until `resumeAt`, never negative. */
function secondsUntil(resumeAt: number, nowMs: number): number {
  return Math.max(0, Math.ceil((resumeAt - nowMs) / 1_000));
}

/** One-line description of why the turn is paused, with a live countdown. */
export function turnStatusLabel(status: ActiveTurnStatus, nowMs: number): string {
  if (status.state === "queued") {
    return status.position <= 1
      ? "In the queue behind other research requests. You're next."
      : `In the queue behind other research requests. Position ${status.position}.`;
  }
  const seconds = secondsUntil(status.resumeAt, nowMs);
  const when = seconds > 0 ? `Resuming in ${seconds}s.` : "Resuming any moment.";
  return `Waiting for ${status.modelLabel}'s rate limit before ${STAGE_ACTIVITY[status.stage]}. ${when}`;
}
