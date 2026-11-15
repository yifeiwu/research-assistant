import { UI_MESSAGE_STREAM_HEADERS } from "ai";
import { describe, expect, it } from "vitest";
import { createChatSession, type SessionStreamEnd } from "@/lib/chat-session";
import { streamEndEvent } from "@/lib/turn-machine";

const CHAT = "chat-session-1";
const frame = (chunk: unknown) => `data: ${JSON.stringify(chunk)}\n\n`;
const DONE = "data: [DONE]\n\n";

/** An answer's stream as the server sends it, without the closing frame. */
const ANSWER =
  frame({ type: "start", messageId: "msg-req12345" }) +
  frame({ type: "text-start", id: "t1" }) +
  frame({ type: "text-delta", id: "t1", delta: "Hello." }) +
  frame({ type: "text-end", id: "t1" }) +
  frame({ type: "finish", finishReason: "stop" });

const sse = (body: string) => new Response(body, { headers: UI_MESSAGE_STREAM_HEADERS });

/** A session whose requests are answered by `respond`, and the stream ends it reports. */
function sessionWith(respond: (method: string, init?: RequestInit) => Promise<Response> | Response) {
  const session = createChatSession(CHAT, {
    fetch: async (_input, init) => respond((init?.method ?? "GET").toUpperCase(), init),
  });
  const ends: SessionStreamEnd[] = [];
  session.onStreamEnd((end) => ends.push(end));
  /** What the turn machine makes of the last stream end. */
  const lastEvent = () => streamEndEvent(CHAT, ends[ends.length - 1]).type;
  return { session, ends, lastEvent };
}

describe("a turn's own stream", () => {
  it("that ends with the closing frame is reported as a turn that finished", async () => {
    const { session, ends, lastEvent } = sessionWith(() => sse(ANSWER + DONE));
    await session.chat.sendMessage({ text: "hi" });

    expect(ends).toHaveLength(1);
    expect(ends[0]).toMatchObject({ isAbort: false, isError: false, networkDrop: false });
    // The message carries the id the server gave it.
    expect(ends[0].messages.map((m) => [m.role, m.id])).toEqual([
      ["user", expect.any(String)],
      ["assistant", "msg-req12345"],
    ]);
    expect(lastEvent()).toBe("FINISHED");
  });

  it("that ends without it is reported as dropped, whatever it had delivered", async () => {
    // The server handed the turn on to a later request.
    const { session, ends, lastEvent } = sessionWith(() => sse(ANSWER));
    await session.chat.sendMessage({ text: "hi" });

    expect(ends[0]).toMatchObject({ isError: true, networkDrop: true });
    expect(lastEvent()).toBe("DROPPED");
  });

  it("that carries an error from the server is reported as failed", async () => {
    const { session, lastEvent } = sessionWith(() =>
      sse(
        frame({ type: "start", messageId: "msg-req12345" }) +
          frame({ type: "error", errorText: "The model provider had a server error (HTTP 503)." }) +
          DONE,
      ),
    );
    await session.chat.sendMessage({ text: "hi" });

    expect(lastEvent()).toBe("FAILED");
    expect(session.chat.error?.message).toContain("HTTP 503");
  });

  it("a request the server refuses is reported as failed, not as a lost connection", async () => {
    const { session, ends, lastEvent } = sessionWith(() =>
      Response.json({ error: "You're sending messages too quickly." }, { status: 429 }),
    );
    await session.chat.sendMessage({ text: "hi" });

    expect(ends[0]).toMatchObject({ isError: true, networkDrop: false });
    expect(lastEvent()).toBe("FAILED");
  });

  it("a request that never reaches the server is reported as dropped", async () => {
    const { session, lastEvent } = sessionWith(() => {
      throw new TypeError("Failed to fetch");
    });
    await session.chat.sendMessage({ text: "hi" });
    expect(lastEvent()).toBe("DROPPED");
  });
});

describe("a reconnect", () => {
  it("that finds nothing reports it, and no stream", async () => {
    const { session, ends } = sessionWith(() => new Response(null, { status: 204 }));
    await session.chat.resumeStream();

    expect(session.consumeReconnectOutcome()).toBe("empty");
    // Read once.
    expect(session.consumeReconnectOutcome()).toBeNull();
    expect(ends).toEqual([]);
  });

  it("that replays the turn to its end reports the end like any stream's", async () => {
    const { session, lastEvent } = sessionWith(() => sse(ANSWER + DONE));
    await session.chat.resumeStream();

    expect(session.consumeReconnectOutcome()).toBe("replayed");
    expect(lastEvent()).toBe("FINISHED");
    expect(session.chat.messages.at(-1)).toMatchObject({ role: "assistant", id: "msg-req12345" });
  });

  it("whose stream ends before the turn does says so", async () => {
    const { session, lastEvent } = sessionWith(() => sse(ANSWER));
    await session.chat.resumeStream();

    expect(session.consumeReconnectOutcome()).toBe("unfinished");
    expect(lastEvent()).toBe("DROPPED");
  });

  it("tells a server it cannot reach from one that answers with an error", async () => {
    const offline = sessionWith(() => {
      throw new TypeError("Failed to fetch");
    });
    await offline.session.chat.resumeStream();
    expect(offline.session.consumeReconnectOutcome()).toBe("network-error");

    const broken = sessionWith(() => Response.json({ error: "boom" }, { status: 500 }));
    await broken.session.chat.resumeStream();
    expect(broken.session.consumeReconnectOutcome()).toBe("error");
    // Neither had a stream to end.
    expect([...offline.ends, ...broken.ends]).toEqual([]);
  });

  it("can be given up while its request is in flight", async () => {
    let requestSent!: () => void;
    const inFlight = new Promise<void>((resolve) => {
      requestSent = resolve;
    });
    const { session } = sessionWith(
      (_method, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("The operation was aborted.", "AbortError")),
          );
          requestSent();
        }),
    );
    const resuming = session.chat.resumeStream();
    await inFlight;
    session.abortReconnect();
    await resuming;

    expect(session.consumeReconnectOutcome()).toBe("aborted");
  });
});
