import { describe, expect, it } from "vitest";
import {
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
/** Large enough to be flushed at once, which is when stop flags are read. */
const BIG = note("x".repeat(17_000));

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

  it("remote stop aborts the attempt streaming the run on flush", async () => {
    const fake = new FakeRedis();
    const handle = await startRun(fake);
    await stopChatStream(CHAT, undefined, asDb(fake));
    await ingestChunkStream(handle, streamOf(BIG), attemptFor(handle), asDb(fake));
    expect(handle.abortController.signal.aborted).toBe(true);
  });

  it("a superseding run aborts the attempt streaming the previous one", async () => {
    const fake = new FakeRedis();
    const first = await startRun(fake);
    await startChatStream(CHAT, undefined, asDb(fake));
    await ingestChunkStream(first, streamOf(BIG), attemptFor(first), asDb(fake));
    expect(first.abortController.signal.aborted).toBe(true);
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
    await ingestChunkStream(second, streamOf(BIG), attemptFor(second), asDb(fake));
    expect(second.abortController.signal.aborted).toBe(false);
  });

  it("a stop for the current turn still aborts it", async () => {
    const fake = new FakeRedis();
    const handle = await startRun(fake, "turn-9");
    await stopChatStream(CHAT, "turn-9", asDb(fake));
    await ingestChunkStream(handle, streamOf(BIG), attemptFor(handle), asDb(fake));
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
