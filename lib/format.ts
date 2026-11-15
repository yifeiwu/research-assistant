import type { TurnPhase } from "@/lib/turn-machine";

/** Label for the in-flight status indicator: what the turn is doing right now. */
export function busyLabel(
  phase: TurnPhase | undefined,
  idleSeconds: number,
  opts: {
    /** Nothing of the response has arrived yet. */
    nothingYet?: boolean;
    /** The turn is queued or waiting on a rate limit (the message says why). */
    paused?: boolean;
    /** A reconnect is replaying what the page already shows. */
    replaying?: boolean;
  } = {},
): string {
  if (opts.replaying || phase === "detached" || phase === "resuming") {
    return "Reconnecting…";
  }
  if (phase === "sending" || opts.nothingYet) return "Thinking…";
  if (opts.paused) return "Waiting…";
  // Streaming: if no new output has arrived for a few seconds, the model is
  // likely searching/reading/summarizing. Reassure the user it's still alive.
  if (idleSeconds >= 4) return "Still working — searching and reading sources…";
  return "Responding…";
}

/** Format a duration in seconds as `12s` or `1m 05s`. */
export function formatDuration(totalSeconds: number): string {
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${seconds.toString().padStart(2, "0")}s`;
}
