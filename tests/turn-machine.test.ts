import { describe, expect, it } from "vitest";
import {
  MAX_UNFINISHED_RECONNECTS,
  initialTurnState,
  isPending,
  reconnectEvent,
  reconnectWhen,
  streamEndEvent,
  turnReducer,
  type StreamEnd,
  type TurnEvent,
  type TurnState,
} from "@/lib/turn-machine";

const A = "chat-a";
const B = "chat-b";

/** The state after `events`, starting with thread A open and nothing in flight. */
const after = (...events: TurnEvent[]): TurnState =>
  events.reduce(turnReducer, initialTurnState(A));

const send = (chatId = A): TurnEvent => ({ type: "SEND", chatId, at: 1_000 });
const turnOf = (state: TurnState, chatId = A) => state.threads[chatId];
const pendingIn = (state: TurnState, chatId = A) => isPending(turnOf(state, chatId)?.phase);
const reconnectIn = (state: TurnState, chatId = A) => reconnectWhen(turnOf(state, chatId));

describe("a turn from send to end", () => {
  it("is pending from the moment it is sent until its stream ends properly", () => {
    const sent = after(send());
    expect(turnOf(sent)).toMatchObject({ phase: "sending", since: 1_000 });
    expect(pendingIn(sent)).toBe(true);

    const streaming = turnReducer(sent, { type: "STREAMING", chatId: A });
    expect(turnOf(streaming).phase).toBe("streaming");
    expect(pendingIn(streaming)).toBe(true);
    // Connected, so there is nothing to reconnect to.
    expect(reconnectIn(streaming)).toBeNull();

    const finished = turnReducer(streaming, { type: "FINISHED", chatId: A });
    expect(turnOf(finished).phase).toBe("idle");
    expect(pendingIn(finished)).toBe(false);
    expect(turnOf(finished).since).toBeUndefined();
  });

  it("ends as failed when the server says so", () => {
    const failed = after(send(), { type: "FAILED", chatId: A });
    expect(turnOf(failed).phase).toBe("failed");
    expect(pendingIn(failed)).toBe(false);
  });

  it("ignores a stream's end for a turn that is already over", () => {
    for (const settled of [
      after(),
      after(send(), { type: "FINISHED", chatId: A }),
      after(send(), { type: "STOP", chatId: A }),
    ]) {
      for (const type of ["FINISHED", "FAILED", "DROPPED", "STREAMING"] as const) {
        expect(turnReducer(settled, { type, chatId: A })).toBe(settled);
      }
    }
  });

  it("starts each new turn on a thread from scratch", () => {
    const resent = after(send(), { type: "STOP", chatId: A }, { type: "SEND", chatId: A, at: 5_000 });
    expect(turnOf(resent)).toEqual({
      phase: "sending",
      since: 5_000,
      reconnect: "now",
      unfinished: 0,
      resumed: false,
    });
  });
});

describe("losing the stream", () => {
  it("leaves the turn pending, and reconnects to it straight away, once", () => {
    const dropped = after(send(), { type: "STREAMING", chatId: A }, { type: "DROPPED", chatId: A });
    expect(turnOf(dropped).phase).toBe("detached");
    expect(pendingIn(dropped)).toBe(true);
    expect(reconnectIn(dropped)).toBe("now");

    // Reconnected, replaying, and dropped again: wait for the user to come
    // back rather than answer a bad connection with a loop of requests.
    const again = [
      { type: "RESUME_START", chatId: A },
      { type: "STREAMING", chatId: A },
      { type: "DROPPED", chatId: A },
    ].reduce(turnReducer as (s: TurnState, e: unknown) => TurnState, dropped);
    expect(pendingIn(again)).toBe(true);
    expect(reconnectIn(again)).toBe("on-return");
  });

  it("is connected again while a reconnect is under way", () => {
    const resuming = after(send(), { type: "DROPPED", chatId: A }, { type: "RESUME_START", chatId: A });
    expect(turnOf(resuming).phase).toBe("resuming");
    expect(pendingIn(resuming)).toBe(true);
    expect(reconnectIn(resuming)).toBeNull();
    // Only a detached turn can be reconnected to.
    const streaming = after(send());
    expect(turnReducer(streaming, { type: "RESUME_START", chatId: A })).toBe(streaming);
  });

  it("finishes through a reconnect like any other stream", () => {
    const done = after(
      send(),
      { type: "DROPPED", chatId: A },
      { type: "RESUME_START", chatId: A },
      { type: "STREAMING", chatId: A },
      { type: "FINISHED", chatId: A },
    );
    expect(turnOf(done).phase).toBe("idle");
  });

  it("waits for the user's return when the server cannot be reached", () => {
    const offline = after(
      send(),
      { type: "DROPPED", chatId: A },
      { type: "RESUME_START", chatId: A },
      { type: "RESUME_FAILED", chatId: A },
    );
    expect(pendingIn(offline)).toBe(true);
    expect(reconnectIn(offline)).toBe("on-return");
  });

  it("is over, as expired, once the server has nothing left of it", () => {
    const expired = after(
      send(),
      { type: "DROPPED", chatId: A },
      { type: "RESUME_START", chatId: A },
      { type: "RESUME_EMPTY", chatId: A },
    );
    expect(turnOf(expired).phase).toBe("expired");
    expect(pendingIn(expired)).toBe(false);
    expect(reconnectIn(expired)).toBeNull();
  });
});

describe("streams the server ends early (a turn handed on to the next request)", () => {
  /** One reconnect whose stream ended before the turn did. */
  const unfinishedReconnect: TurnEvent[] = [
    { type: "RESUME_START", chatId: A },
    { type: "STREAMING", chatId: A },
    // The early end reaches the page as a dropped stream first.
    { type: "DROPPED", chatId: A },
    { type: "RESUME_UNFINISHED", chatId: A },
  ];

  it("reconnects after a pause, a limited number of times in a row", () => {
    let state = after(send(), { type: "DROPPED", chatId: A });
    for (let i = 1; i <= MAX_UNFINISHED_RECONNECTS; i++) {
      state = unfinishedReconnect.reduce(turnReducer, state);
      expect(reconnectIn(state)).toBe("soon");
      expect(turnOf(state).unfinished).toBe(i);
    }
    // A server that keeps ending streams early is not chased any further.
    state = unfinishedReconnect.reduce(turnReducer, state);
    expect(pendingIn(state)).toBe(true);
    expect(reconnectIn(state)).toBe("on-return");
  });

  it("counts from zero again once the thread is reopened", () => {
    let state = after(send(), { type: "DROPPED", chatId: A });
    for (let i = 0; i <= MAX_UNFINISHED_RECONNECTS; i++) {
      state = unfinishedReconnect.reduce(turnReducer, state);
    }
    state = turnReducer(state, { type: "ACTIVATE", chatId: A });
    expect(turnOf(state)).toMatchObject({ phase: "detached", reconnect: "now", unfinished: 0 });
    state = unfinishedReconnect.reduce(turnReducer, state);
    expect(reconnectIn(state)).toBe("soon");
  });
});

describe("stopping", () => {
  it("ends the turn whatever state it was in, and nothing reconnects to it", () => {
    for (const before of [
      after(send()),
      after(send(), { type: "STREAMING", chatId: A }),
      after(send(), { type: "DROPPED", chatId: A }),
      after(send(), { type: "DROPPED", chatId: A }, { type: "RESUME_START", chatId: A }),
    ]) {
      const stopped = turnReducer(before, { type: "STOP", chatId: A });
      expect(turnOf(stopped).phase).toBe("stopped");
      expect(pendingIn(stopped)).toBe(false);
      expect(reconnectIn(stopped)).toBeNull();
      // Its stream, given up by the stop, ends a moment later.
      expect(turnReducer(stopped, { type: "DROPPED", chatId: A })).toBe(stopped);
    }
  });
});

describe("threads", () => {
  it("leaving a thread lets go of its stream, and its turn stays pending", () => {
    const left = after(send(), { type: "STREAMING", chatId: A }, { type: "ACTIVATE", chatId: B });
    expect(left.activeId).toBe(B);
    expect(turnOf(left, A).phase).toBe("detached");
    expect(pendingIn(left, A)).toBe(true);
    // The other thread has no turn of its own.
    expect(turnOf(left, B)).toBeUndefined();
  });

  it("opening a thread with a pending turn reconnects to it at once", () => {
    const back = after(
      send(),
      { type: "DROPPED", chatId: A },
      { type: "RESUME_START", chatId: A },
      { type: "RESUME_FAILED", chatId: A }, // waiting for the user's return
      { type: "ACTIVATE", chatId: B },
      { type: "ACTIVATE", chatId: A },
    );
    expect(reconnectIn(back)).toBe("now");
  });

  it("opening a thread does not disturb a turn that is over", () => {
    const stopped = after(send(), { type: "STOP", chatId: A }, { type: "ACTIVATE", chatId: B });
    const back = turnReducer(stopped, { type: "ACTIVATE", chatId: A });
    expect(turnOf(back, A)).toBe(turnOf(stopped, A));
  });

  it("turns found pending in storage are reconnected to or collected", () => {
    const loaded = after({
      type: "HYDRATE",
      pending: [{ chatId: A, since: 500 }, { chatId: B }],
    });
    expect(turnOf(loaded, A)).toMatchObject({ phase: "detached", since: 500, reconnect: "now" });
    expect(pendingIn(loaded, B)).toBe(true);

    // The open thread reconnects; the other is collected in the background.
    const collected = turnReducer(loaded, { type: "COLLECTED", chatId: B });
    expect(turnOf(collected, B).phase).toBe("idle");
    // Or found to have expired.
    const gone = turnReducer(loaded, { type: "RESUME_EMPTY", chatId: B });
    expect(turnOf(gone, B).phase).toBe("expired");
  });

  it("a deleted thread's turn is forgotten, and comes back pending if the delete is undone", () => {
    const deleted = after(send(), { type: "ACTIVATE", chatId: B }, { type: "FORGET", chatId: A });
    expect(turnOf(deleted, A)).toBeUndefined();

    const restored = turnReducer(deleted, { type: "RESTORE", chatId: A, pending: true, since: 1_000 });
    expect(turnOf(restored, A)).toMatchObject({ phase: "detached", since: 1_000 });
    // A thread that had nothing pending comes back with no turn.
    expect(turnReducer(deleted, { type: "RESTORE", chatId: A, pending: false })).toBe(deleted);
  });
});

describe("what the end of a stream means (the closing-frame rule)", () => {
  const end = (over: Partial<StreamEnd>): StreamEnd => ({
    isAbort: false,
    isError: false,
    networkDrop: false,
    ...over,
  });

  it("a stream that ended with its closing frame ended its turn", () => {
    expect(streamEndEvent(A, end({}))).toEqual({ type: "FINISHED", chatId: A });
  });

  it("an error from the server ends the turn as failed", () => {
    // An error part in the stream, or the request refused outright.
    expect(streamEndEvent(A, end({ isError: true }))).toEqual({ type: "FAILED", chatId: A });
  });

  it("anything else leaves the turn pending", () => {
    // The connection dropped, or the stream ended without its closing frame
    // (lib/unfinished-stream.ts reports that as a network error).
    expect(streamEndEvent(A, end({ isError: true, networkDrop: true }))).toEqual({
      type: "DROPPED",
      chatId: A,
    });
    // The page let go of the stream itself (the thread was left).
    expect(streamEndEvent(A, end({ isAbort: true }))).toEqual({ type: "DROPPED", chatId: A });
  });
});

describe("what a reconnect's outcome means", () => {
  it("says what the stream's own end has not already said", () => {
    expect(reconnectEvent(A, "unfinished")).toEqual({ type: "RESUME_UNFINISHED", chatId: A });
    expect(reconnectEvent(A, "network-error")).toEqual({ type: "RESUME_FAILED", chatId: A });
    expect(reconnectEvent(A, "empty")).toEqual({ type: "RESUME_EMPTY", chatId: A });
    expect(reconnectEvent(A, "error")).toEqual({ type: "RESUME_EMPTY", chatId: A });
    // A replay's end is reported like any other stream's.
    expect(reconnectEvent(A, "replayed")).toBeNull();
    expect(reconnectEvent(A, null)).toBeNull();
  });

  it("a reconnect given up before its stream began leaves the turn detached, not stuck resuming", () => {
    const resuming = after(send(), { type: "DROPPED", chatId: A }, { type: "RESUME_START", chatId: A });
    const event = reconnectEvent(A, "aborted")!;
    const state = turnReducer(resuming, event);
    expect(turnOf(state).phase).toBe("detached");
    // Given up by stopping the turn, it changes nothing.
    const stopped = turnReducer(resuming, { type: "STOP", chatId: A });
    expect(turnReducer(stopped, event)).toBe(stopped);
  });
});
