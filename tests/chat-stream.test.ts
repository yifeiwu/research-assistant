import { describe, expect, it, vi } from "vitest";
import {
  endChatRun,
  ingestChunkStream,
  resumeChatStream,
  runLeaseKey,
  startChatStream,
  stopChatStream,
  type ChatRun,
} from "@/lib/agent/chat-stream";
import { FakeRedis, streamOf } from "./fake-redis";

type Db = Parameters<typeof startChatStream>[2];
const asDb = (fake: FakeRedis) => fake as unknown as Db;
const CHAT = "chat-test-1234";

/** Register a run on the chat, as `POST /api/chat` does, for an attempt to stream. */
async function startRun(fake: FakeRedis, turnId?: string): Promise<ChatRun> {
  const { runId } = await startChatStream(CHAT, turnId, asDb(fake));
  return { chatId: CHAT, runId, abortController: new AbortController() };
}

/** An attempt that streams the run to its end. */
const attemptFor = (run: ChatRun) => ({
  lease: { key: runLeaseKey(run.runId), token: "attempt-1", ttlSeconds: 12 },
  wakeAt: Promise.resolve(undefined),
});

const note = (text: string) => ({ type: "data-note", data: text });

/** A source stream the test feeds by hand, so an attempt can be held open. */
function openStream() {
  let controller!: ReadableStreamDefaultController<{ type: string }>;
  const stream = new ReadableStream<{ type: string }>({
    start(c) {
      controller = c;
    },
  });
  return {
    stream,
    push: (chunk: { type: string }) => controller.enqueue(chunk),
    close: () => controller.close(),
  };
}

/**
 * An attempt that streams something and stays open for one heartbeat, which
 * is when it learns what happened to its run meanwhile. Then it ends.
 */
async function ingestOverHeartbeat(
  fake: FakeRedis,
  run: ChatRun,
  chunk: { type: string } = note("working"),
): Promise<void> {
  vi.useFakeTimers();
  try {
    const source = openStream();
    const ingest = ingestChunkStream(run, source.stream, attemptFor(run), asDb(fake));
    source.push(chunk);
    await vi.advanceTimersByTimeAsync(1_000);
    source.close();
    await ingest;
  } finally {
    vi.useRealTimers();
  }
}

/** The commands of every pipeline sent from now on, one list per round trip. */
function recordRoundTrips(fake: FakeRedis): string[][] {
  const trips: string[][] = [];
  const originalPipeline = fake.pipeline.bind(fake);
  fake.pipeline = (() => {
    const pipe = originalPipeline();
    const commands: string[] = [];
    for (const name of Object.keys(pipe)) {
      if (name === "exec") continue;
      const queue = pipe[name] as (...args: unknown[]) => unknown;
      pipe[name] = (...args: unknown[]) => {
        commands.push(name);
        queue(...args);
        return pipe;
      };
    }
    const exec = pipe.exec as () => Promise<unknown[]>;
    pipe.exec = async () => {
      trips.push(commands);
      return exec();
    };
    return pipe;
  }) as typeof fake.pipeline;
  return trips;
}

describe("chat-stream cross-instance protocol", () => {
  it("start -> ingest -> resume replays buffered SSE", async () => {
    const fake = new FakeRedis();
    const handle = await startRun(fake);
    await ingestChunkStream(handle, streamOf(note("hello")), attemptFor(handle), asDb(fake));
    const res = await resumeChatStream(CHAT, undefined, undefined, asDb(fake));
    expect(res).not.toBeNull();
    expect(await res!.text()).toContain("hello");
  });

  it("onlyDone returns 202 while streaming and the payload once done", async () => {
    const fake = new FakeRedis();
    const handle = await startRun(fake);
    const early = await resumeChatStream(CHAT, undefined, { onlyDone: true }, asDb(fake));
    expect(early?.status).toBe(202);
    await ingestChunkStream(handle, streamOf(note("done-chunk")), attemptFor(handle), asDb(fake));
    const late = await resumeChatStream(CHAT, undefined, { onlyDone: true }, asDb(fake));
    expect(late?.status).toBe(200);
    expect(await late!.text()).toContain("done-chunk");
  });

  it("remote stop aborts the attempt streaming the run at its next heartbeat", async () => {
    const fake = new FakeRedis();
    const handle = await startRun(fake);
    await stopChatStream(CHAT, undefined, asDb(fake));
    await ingestOverHeartbeat(fake, handle);
    expect(handle.abortController.signal.aborted).toBe(true);
  });

  it("a superseding run aborts the attempt streaming the previous one", async () => {
    const fake = new FakeRedis();
    const first = await startRun(fake);
    await startChatStream(CHAT, undefined, asDb(fake));
    await ingestOverHeartbeat(fake, first);
    expect(first.abortController.signal.aborted).toBe(true);
  });

  it("an attempt whose run was ended elsewhere stops working, and adds nothing to what clients replay", async () => {
    const fake = new FakeRedis();
    const handle = await startRun(fake);
    // Closed behind the attempt's back, as a stop does for a run it finds
    // waiting, or another invocation does for one it takes for dead.
    await endChatRun(CHAT, handle.runId, { type: "abort" }, asDb(fake));

    await ingestOverHeartbeat(fake, handle, note("written-after-the-end"));

    // Its work is stopped rather than left to run to completion unseen.
    expect(handle.abortController.signal.aborted).toBe(true);
    // What it wrote before it noticed lies beyond the closing frame, where
    // no reader goes; and it did not close the stream a second time.
    const stored = fake.lists.get(`chat:run:${handle.runId}:chunks`)!.join("");
    expect(stored).toContain("written-after-the-end");
    expect(stored.split("[DONE]")).toHaveLength(2);
    for (const opts of [undefined, { onlyDone: true }]) {
      const res = await resumeChatStream(CHAT, undefined, opts, asDb(fake));
      const replay = await res!.text();
      expect(replay).not.toContain("written-after-the-end");
      expect(replay.endsWith("data: [DONE]\n\n")).toBe(true);
    }
  });

  it("flushes only what was streamed, and leaves keeping the run alive to the heartbeat", async () => {
    const fake = new FakeRedis();
    const handle = await startRun(fake);
    const trips = recordRoundTrips(fake);
    vi.useFakeTimers();
    try {
      const source = openStream();
      const ingest = ingestChunkStream(handle, source.stream, attemptFor(handle), asDb(fake));

      // The first of the answer: recorded as started along with its text.
      source.push({ type: "text-start" });
      await vi.advanceTimersByTimeAsync(200);
      expect(trips).toEqual([["hset", "rpush", "expire"]]);
      expect(fake.hashes.get(`chat:run:${handle.runId}:meta`)!.answerStarted).toBe("1");

      // From then on a flush is the batch and nothing else.
      source.push(note("more of the answer"));
      await vi.advanceTimersByTimeAsync(200);
      source.push(note("and more"));
      await vi.advanceTimersByTimeAsync(200);
      expect(trips.slice(1)).toEqual([["rpush"], ["rpush"]]);
      expect(fake.strings.has(runLeaseKey(handle.runId))).toBe(false);

      // Once a second: liveness, the lease, and a look at the stop flags.
      await vi.advanceTimersByTimeAsync(400);
      expect(trips).toHaveLength(4);
      expect(trips[3]).toEqual(expect.arrayContaining(["hget", "get", "hset", "expire", "set"]));
      expect(fake.strings.get(runLeaseKey(handle.runId))).toBe("attempt-1");
      expect(handle.abortController.signal.aborted).toBe(false);

      source.close();
      await ingest;
    } finally {
      vi.useRealTimers();
    }
    const res = await resumeChatStream(CHAT, undefined, undefined, asDb(fake));
    const replay = await res!.text();
    expect(replay).toContain("more of the answer");
    expect(replay).toContain("and more");
  });

  it("a stop that arrives before its turn registers the run as already stopped", async () => {
    const fake = new FakeRedis();
    await stopChatStream(CHAT, "turn-1", asDb(fake));
    const started = await startChatStream(CHAT, "turn-1", asDb(fake));
    expect(started.preStopped).toBe(true);
  });

  it("stale runs with chunks still replay", async () => {
    const fake = new FakeRedis();
    const handle = await startRun(fake);
    fake.lists.set(`chat:run:${handle.runId}:chunks`, ["data: stale\n\n"]);
    const meta = fake.hashes.get(`chat:run:${handle.runId}:meta`)!;
    meta.updatedAt = String(Date.now() - 120_000);
    const res = await resumeChatStream(CHAT, undefined, undefined, asDb(fake));
    expect(await res!.text()).toContain("stale");
  });

  it("a delayed stop for an old turn does not kill the new turn", async () => {
    const fake = new FakeRedis();
    await startChatStream(CHAT, "turn-1", asDb(fake));
    const second = await startRun(fake, "turn-2");
    await stopChatStream(CHAT, "turn-1", asDb(fake));
    await ingestOverHeartbeat(fake, second);
    expect(second.abortController.signal.aborted).toBe(false);
  });

  it("a stop for the current turn still aborts it", async () => {
    const fake = new FakeRedis();
    const handle = await startRun(fake, "turn-9");
    await stopChatStream(CHAT, "turn-9", asDb(fake));
    await ingestOverHeartbeat(fake, handle);
    expect(handle.abortController.signal.aborted).toBe(true);
  });

  it("a failed Redis flush restores the batch for the finalize retry", async () => {
    const fake = new FakeRedis();
    const handle = await startRun(fake);
    const originalPipeline = fake.pipeline.bind(fake);
    let failures = 1;
    fake.pipeline = (() => {
      const pipe = originalPipeline();
      const exec = pipe.exec as () => Promise<unknown[]>;
      pipe.exec = async () => {
        if (failures-- > 0) throw new Error("redis blip");
        return exec();
      };
      return pipe;
    }) as typeof fake.pipeline;
    await ingestChunkStream(handle, streamOf(note("preserved")), attemptFor(handle), asDb(fake));
    const res = await resumeChatStream(CHAT, undefined, undefined, asDb(fake));
    const replay = await res!.text();
    expect(replay).toContain("preserved");
    // The retry must not close the stream a second time.
    expect(replay.split("[DONE]")).toHaveLength(2);
  });

  it("onlyDone marks stale partial payloads with the stale header", async () => {
    const fake = new FakeRedis();
    const handle = await startRun(fake);
    fake.lists.set(`chat:run:${handle.runId}:chunks`, ["data: partial\n\n"]);
    const meta = fake.hashes.get(`chat:run:${handle.runId}:meta`)!;
    meta.updatedAt = String(Date.now() - 120_000);
    const res = await resumeChatStream(CHAT, undefined, { onlyDone: true }, asDb(fake));
    expect(res?.headers.get("x-chat-stream-stale")).toBe("1");
  });
});
