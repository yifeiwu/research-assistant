import { describe, expect, it } from "vitest";
import {
  ingestSseStream,
  resumeChatStream,
  resumePollDelayMs,
  startChatStream,
  stopChatStream,
} from "@/lib/agent/chat-stream";
import { FakeRedis, streamOf } from "./fake-redis";

type Db = Parameters<typeof startChatStream>[2];
const asDb = (fake: FakeRedis) => fake as unknown as Db;
const CHAT = "chat-test-1234";

describe("chat-stream cross-instance protocol", () => {
  it("start -> ingest -> resume replays buffered SSE", async () => {
    const fake = new FakeRedis();
    const handle = await startChatStream(CHAT, undefined, asDb(fake));
    await ingestSseStream(handle, streamOf("data: hello\n\n"), asDb(fake));
    const res = await resumeChatStream(CHAT, undefined, undefined, asDb(fake));
    expect(res).not.toBeNull();
    expect(await res!.text()).toContain("hello");
  });

  it("onlyDone returns 202 while streaming and the payload once done", async () => {
    const fake = new FakeRedis();
    const handle = await startChatStream(CHAT, undefined, asDb(fake));
    const early = await resumeChatStream(CHAT, undefined, { onlyDone: true }, asDb(fake));
    expect(early?.status).toBe(202);
    await ingestSseStream(handle, streamOf("data: done-chunk\n\n"), asDb(fake));
    const late = await resumeChatStream(CHAT, undefined, { onlyDone: true }, asDb(fake));
    expect(late?.status).toBe(200);
    expect(await late!.text()).toContain("done-chunk");
  });

  it("remote stop aborts the generating isolate on flush", async () => {
    const fake = new FakeRedis();
    const handle = await startChatStream(CHAT, undefined, asDb(fake));
    await stopChatStream(CHAT, undefined, asDb(fake));
    await ingestSseStream(handle, streamOf("x".repeat(17_000)), asDb(fake));
    expect(handle.abortSignal.aborted).toBe(true);
  });

  it("a superseding run aborts the previous isolate", async () => {
    const fake = new FakeRedis();
    const first = await startChatStream(CHAT, undefined, asDb(fake));
    await startChatStream(CHAT, undefined, asDb(fake));
    await ingestSseStream(first, streamOf("x".repeat(17_000)), asDb(fake));
    expect(first.abortSignal.aborted).toBe(true);
  });

  it("pre-start stop tombstone aborts a late-starting run", async () => {
    const fake = new FakeRedis();
    await stopChatStream(CHAT, "turn-1", asDb(fake));
    const handle = await startChatStream(CHAT, "turn-1", asDb(fake));
    expect(handle.abortSignal.aborted).toBe(true);
  });

  it("stale runs with chunks still replay", async () => {
    const fake = new FakeRedis();
    const handle = await startChatStream(CHAT, undefined, asDb(fake));
    fake.lists.set(`chat:run:${handle.runId}:chunks`, ["data: stale\n\n"]);
    const meta = fake.hashes.get(`chat:run:${handle.runId}:meta`)!;
    meta.updatedAt = String(Date.now() - 120_000);
    const res = await resumeChatStream(CHAT, undefined, undefined, asDb(fake));
    expect(await res!.text()).toContain("stale");
  });

  it("a delayed stop for an old turn does not kill the new turn", async () => {
    const fake = new FakeRedis();
    await startChatStream(CHAT, "turn-1", asDb(fake));
    const second = await startChatStream(CHAT, "turn-2", asDb(fake));
    await stopChatStream(CHAT, "turn-1", asDb(fake));
    await ingestSseStream(second, streamOf("x".repeat(17_000)), asDb(fake));
    expect(second.abortSignal.aborted).toBe(false);
  });

  it("a stop for the current turn still aborts it", async () => {
    const fake = new FakeRedis();
    const handle = await startChatStream(CHAT, "turn-9", asDb(fake));
    await stopChatStream(CHAT, "turn-9", asDb(fake));
    await ingestSseStream(handle, streamOf("x".repeat(17_000)), asDb(fake));
    expect(handle.abortSignal.aborted).toBe(true);
  });

  it("a failed Redis flush restores the batch for the finalize retry", async () => {
    const fake = new FakeRedis();
    const handle = await startChatStream(CHAT, undefined, asDb(fake));
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
    await ingestSseStream(handle, streamOf("data: preserved\n\n"), asDb(fake));
    const res = await resumeChatStream(CHAT, undefined, undefined, asDb(fake));
    expect(await res!.text()).toContain("preserved");
  });

  it("onlyDone marks stale partial payloads with the stale header", async () => {
    const fake = new FakeRedis();
    const handle = await startChatStream(CHAT, undefined, asDb(fake));
    fake.lists.set(`chat:run:${handle.runId}:chunks`, ["data: partial\n\n"]);
    const meta = fake.hashes.get(`chat:run:${handle.runId}:meta`)!;
    meta.updatedAt = String(Date.now() - 120_000);
    const res = await resumeChatStream(CHAT, undefined, { onlyDone: true }, asDb(fake));
    expect(res?.headers.get("x-chat-stream-stale")).toBe("1");
  });

  it("resume poll delay is bounded with backoff", () => {
    for (let i = 0; i < 20; i++) {
      expect(resumePollDelayMs(0)).toBeGreaterThanOrEqual(160);
      expect(resumePollDelayMs(10)).toBeLessThanOrEqual(1_400);
    }
  });
});
