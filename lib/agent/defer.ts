import "server-only";

/**
 * Why an attempt is stopping short of finishing its turn:
 * - `queued`: still waiting for a research slot.
 * - `rate-limit`: the answer's model has no room until its window reopens.
 * - `handoff`: this invocation has run too long to start the answer safely.
 */
export type DeferReason = "queued" | "rate-limit" | "handoff";

/**
 * Thrown inside a turn to stop this attempt without ending the turn: nothing
 * terminal is written to the stream, and a later attempt continues after
 * `delayMs` (from the last checkpoint). See lib/agent/detached.ts.
 */
export class TurnDeferredError extends Error {
  readonly delayMs: number;
  readonly reason: DeferReason;
  constructor(reason: DeferReason, delayMs: number) {
    super(`Turn deferred (${reason}) for ${Math.ceil(delayMs / 1_000)}s`);
    this.name = "TurnDeferredError";
    this.reason = reason;
    this.delayMs = Math.max(0, Math.ceil(delayMs));
  }
}

export function isTurnDeferred(error: unknown): error is TurnDeferredError {
  return error instanceof TurnDeferredError;
}
