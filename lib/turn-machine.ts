/**
 * The state of each thread's latest turn, as this page knows it, and every
 * decision that follows from it: whether the turn is still pending, whether
 * and when the page should reconnect to it, and what a stream ending or a
 * reconnect attempt means for it.
 *
 * A turn runs on the server whether or not the page is connected to it
 * (lib/agent/detached.ts), so "pending" is not the same as "streaming here":
 * a turn whose stream was lost stays pending until the page has seen it end.
 * The rule for that is the closing frame. A stream that ends with it has
 * ended its turn; one that ends any other way (lib/unfinished-stream.ts
 * turns a missing frame into a network error) leaves the turn pending.
 *
 * Everything here is pure. The hooks around it (lib/hooks) feed it events
 * and carry out what it decides.
 */

export type TurnPhase =
  /** No turn in flight: there is none, or the latest one completed. */
  | "idle"
  /** Sent; no response yet. */
  | "sending"
  /** Its stream is arriving. */
  | "streaming"
  /** Not connected to it, though it may still be running on the server. */
  | "detached"
  /** Reconnecting to it. */
  | "resuming"
  /** Stopped by the user. */
  | "stopped"
  /** The server no longer has it: there was nothing to reconnect to. */
  | "expired"
  /** Ended with an error. */
  | "failed";

/**
 * When the page reconnects to a detached turn on its own:
 * - `now`: as soon as it can.
 * - `soon`: after a short pause (the server just ended a stream early).
 * - `on-return`: when the user comes back to the page, or it comes back
 *   online. Reconnecting again before then is unlikely to go better.
 */
export type ReconnectWhen = "now" | "soon" | "on-return";

export type ThreadTurn = {
  phase: TurnPhase;
  /** When the turn was sent (epoch ms), while it is pending. */
  since?: number;
  /** Only meaningful while `detached`. */
  reconnect: ReconnectWhen;
  /** Reconnects in a row whose stream ended before the turn did. */
  unfinished: number;
  /** The page has reconnected to this turn since it last opened the thread. */
  resumed: boolean;
};

export type TurnState = {
  /** The thread that is open. Only it is ever connected to its turn. */
  activeId: string;
  threads: Record<string, ThreadTurn>;
};

/** How a reconnect request ended, as the transport saw it. */
export type ReconnectOutcome =
  /** The stream was replayed. Its end is reported like any other stream's. */
  | "replayed"
  /** Replayed, but the stream ended before the turn did. */
  | "unfinished"
  /** Nothing to reconnect to (HTTP 204). */
  | "empty"
  | "aborted"
  /** The server could not be reached. */
  | "network-error"
  /** The server answered with an error. */
  | "error"
  | null;

/** How a request's stream ended (a turn's own, or a reconnect's replay). */
export type StreamEnd = {
  /** The page gave the stream up: the thread was left, or the turn stopped. */
  isAbort: boolean;
  /** It ended in an error of any kind. */
  isError: boolean;
  /** The connection was lost, or the stream ended without its closing frame. */
  networkDrop: boolean;
};

export type TurnEvent =
  /** Threads found pending in storage when the page loaded. */
  | { type: "HYDRATE"; pending: Array<{ chatId: string; since?: number }> }
  /** A thread was opened. */
  | { type: "ACTIVATE"; chatId: string }
  | { type: "SEND"; chatId: string; at: number }
  /** The stream the page is connected to has started delivering. */
  | { type: "STREAMING"; chatId: string }
  /** The turn's stream ended with its closing frame, and without an error. */
  | { type: "FINISHED"; chatId: string }
  /** The server reported an error for the turn, or refused the request. */
  | { type: "FAILED"; chatId: string }
  /** The stream was lost before the turn ended. */
  | { type: "DROPPED"; chatId: string }
  | { type: "STOP"; chatId: string }
  | { type: "RESUME_START"; chatId: string }
  | { type: "RESUME_UNFINISHED"; chatId: string }
  /** A reconnect could not reach the server. */
  | { type: "RESUME_FAILED"; chatId: string }
  /** A reconnect found nothing left of the turn. */
  | { type: "RESUME_EMPTY"; chatId: string }
  /** A background thread's finished answer was collected and saved. */
  | { type: "COLLECTED"; chatId: string }
  /** The thread was deleted. */
  | { type: "FORGET"; chatId: string }
  /** A deleted thread was brought back. */
  | { type: "RESTORE"; chatId: string; pending: boolean; since?: number };

/**
 * How many times in a row the page reconnects straight after a stream that
 * ended early. The limit is for a server that keeps ending them; past it,
 * the page waits for the user to return.
 */
export const MAX_UNFINISHED_RECONNECTS = 4;

export function initialTurnState(activeId: string): TurnState {
  return { activeId, threads: {} };
}

/** True while the turn may still produce (more of) an answer. */
export function isPending(phase: TurnPhase | undefined): boolean {
  return (
    phase === "sending" ||
    phase === "streaming" ||
    phase === "detached" ||
    phase === "resuming"
  );
}

/** True while the page holds a connection to the turn, or is making one. */
function isConnected(phase: TurnPhase): boolean {
  return phase === "sending" || phase === "streaming" || phase === "resuming";
}

/** When the page should reconnect to a turn by itself, or null if it should not. */
export function reconnectWhen(turn: ThreadTurn | undefined): ReconnectWhen | null {
  return turn?.phase === "detached" ? turn.reconnect : null;
}

/** A pending turn the page is not connected to, to be reconnected to at once. */
function detachedTurn(since?: number): ThreadTurn {
  return { phase: "detached", since, reconnect: "now", unfinished: 0, resumed: false };
}

/** The same turn, over: no longer pending, in `phase`. */
function ended(turn: ThreadTurn, phase: TurnPhase): ThreadTurn {
  return { phase, reconnect: "now", unfinished: 0, resumed: turn.resumed };
}

/**
 * What the end of a stream means for its turn. With the closing-frame rule
 * this needs nothing but how the stream ended: no guessing from whether the
 * tab was visible at the time.
 */
export function streamEndEvent(chatId: string, end: StreamEnd): TurnEvent {
  if (end.isAbort || end.networkDrop) return { type: "DROPPED", chatId };
  // An error that is not the connection's is the server's word on the turn.
  if (end.isError) return { type: "FAILED", chatId };
  return { type: "FINISHED", chatId };
}

/**
 * What a reconnect's outcome means for its turn, beyond what the end of its
 * stream (if it had one) has already said.
 */
export function reconnectEvent(
  chatId: string,
  outcome: ReconnectOutcome,
): TurnEvent | null {
  switch (outcome) {
    case "unfinished":
      return { type: "RESUME_UNFINISHED", chatId };
    case "network-error":
      return { type: "RESUME_FAILED", chatId };
    // An error from the stream endpoint leaves nothing to wait for either.
    case "empty":
    case "error":
      return { type: "RESUME_EMPTY", chatId };
    // Given up before a stream began, so no stream's end has said so. (Given
    // up by leaving the thread or stopping the turn, this changes nothing.)
    case "aborted":
      return { type: "DROPPED", chatId };
    default:
      return null;
  }
}

export function turnReducer(state: TurnState, event: TurnEvent): TurnState {
  /** Replace one thread's turn, if `change` has anything to say about it. */
  const update = (
    chatId: string,
    change: (turn: ThreadTurn | undefined) => ThreadTurn | undefined,
  ): TurnState => {
    const current = state.threads[chatId];
    const next = change(current);
    if (!next || next === current) return state;
    return { ...state, threads: { ...state.threads, [chatId]: next } };
  };
  /** Like `update`, for events that only concern a turn that is pending. */
  const updatePending = (
    chatId: string,
    change: (turn: ThreadTurn) => ThreadTurn | undefined,
  ): TurnState =>
    update(chatId, (turn) => (turn && isPending(turn.phase) ? change(turn) : undefined));

  switch (event.type) {
    case "HYDRATE": {
      const threads = { ...state.threads };
      for (const { chatId, since } of event.pending) {
        threads[chatId] ??= detachedTurn(since);
      }
      return { ...state, threads };
    }

    case "ACTIVATE": {
      const threads = { ...state.threads };
      // The thread being left lets go of its stream. Its turn carries on.
      const left = threads[state.activeId];
      if (left && state.activeId !== event.chatId && isConnected(left.phase)) {
        threads[state.activeId] = detachedTurn(left.since);
      }
      // A pending turn on the thread being opened is reconnected to afresh.
      const opened = threads[event.chatId];
      if (opened?.phase === "detached") {
        threads[event.chatId] = detachedTurn(opened.since);
      }
      return { activeId: event.chatId, threads };
    }

    case "SEND":
      return update(event.chatId, () => ({
        phase: "sending",
        since: event.at,
        reconnect: "now",
        unfinished: 0,
        resumed: false,
      }));

    case "STREAMING":
      return update(event.chatId, (turn) =>
        turn?.phase === "sending" || turn?.phase === "resuming"
          ? { ...turn, phase: "streaming" }
          : undefined,
      );

    case "FINISHED":
      return updatePending(event.chatId, (turn) => ended(turn, "idle"));

    case "FAILED":
      return updatePending(event.chatId, (turn) => ended(turn, "failed"));

    case "DROPPED":
      return update(event.chatId, (turn) =>
        turn && isConnected(turn.phase)
          ? {
              ...turn,
              phase: "detached",
              // Once, straight away. A turn that has been reconnected to
              // and dropped again waits for the user to return, so that a
              // bad connection is not answered with a loop of requests.
              reconnect: turn.resumed ? "on-return" : "now",
            }
          : undefined,
      );

    case "STOP":
      return update(event.chatId, (turn) => ({
        phase: "stopped",
        reconnect: "now",
        unfinished: 0,
        resumed: turn?.resumed ?? false,
      }));

    case "RESUME_START":
      return update(event.chatId, (turn) =>
        turn?.phase === "detached"
          ? { ...turn, phase: "resuming", resumed: true }
          : undefined,
      );

    case "RESUME_UNFINISHED":
      return updatePending(event.chatId, (turn) => {
        const unfinished = turn.unfinished + 1;
        return {
          ...turn,
          phase: "detached",
          unfinished,
          reconnect: unfinished <= MAX_UNFINISHED_RECONNECTS ? "soon" : "on-return",
        };
      });

    case "RESUME_FAILED":
      return updatePending(event.chatId, (turn) => ({
        ...turn,
        phase: "detached",
        unfinished: 0,
        reconnect: "on-return",
      }));

    case "RESUME_EMPTY":
      return updatePending(event.chatId, (turn) => ended(turn, "expired"));

    case "COLLECTED":
      return updatePending(event.chatId, (turn) => ended(turn, "idle"));

    case "FORGET": {
      if (!(event.chatId in state.threads)) return state;
      const threads = { ...state.threads };
      delete threads[event.chatId];
      return { ...state, threads };
    }

    case "RESTORE":
      return update(event.chatId, (turn) =>
        !turn && event.pending ? detachedTurn(event.since) : undefined,
      );
  }
}
