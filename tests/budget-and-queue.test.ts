import { describe, expect, it } from "vitest";
import {
  acquirePoolModel,
  createGroqBudget,
  type BudgetStoreDb,
} from "@/lib/agent/groq-budget";
import type { GroqCooldownDb, GroqStage } from "@/lib/agent/groq-rate-limit";
import {
  QueueBusyError,
  createRequestQueue,
  type QueueDb,
} from "@/lib/agent/queue";
import { busyLabel } from "@/lib/format";
import { FakeRedis } from "./fake-redis";

describe("createGroqBudget & acquirePoolModel", () => {
  it("tracks TPM and OTPM refills accurately and learns live header limits", async () => {
    const fake = new FakeRedis();
    let now = 100_000;
    const budget = createGroqBudget({
      db: fake as unknown as BudgetStoreDb,
      now: () => now,
      seedLimits: () => ({ tpm: 8_000, itpm: 7_000, otpm: 1_000 }),
    });

    // Reserve 900 OTPM on Qwen -> granted immediately (100 OTPM left).
    expect(
      await budget.reserve("qwen/qwen3.8-27b", { inputTokens: 2_000, outputTokens: 900 }),
    ).toEqual({ granted: true, waitMs: 0 });

    // Next 900 OTPM call needs 800 more tokens -> 800 / (1000 / 60000) = 48,000ms wait.
    expect(
      await budget.reserve("qwen/qwen3.8-27b", { inputTokens: 500, outputTokens: 900 }),
    ).toEqual({ granted: false, waitMs: 48_000 });

    // Advance 48s -> window refills and grants cleanly!
    now += 48_000;
    expect(
      await budget.reserve("qwen/qwen3.8-27b", { inputTokens: 500, outputTokens: 900 }),
    ).toEqual({ granted: true, waitMs: 0 });

    // Observe Groq header clamping remaining TPM to 200 on a 12,000 TPM tier.
    await budget.observe("qwen/qwen3.8-27b", { limitTokens: 12_000, remainingTokens: 200 });
    expect(budget.limitsFor("qwen/qwen3.8-27b")?.tpm).toBe(12_000);
    expect(
      await budget.reserve("qwen/qwen3.8-27b", { inputTokens: 1_200, outputTokens: 0 }),
    ).toEqual({ granted: false, waitMs: 5_000 });
  });

  it("waits patiently for a rolling token window instead of failing when all pool peers are busy", async () => {
    const fake = new FakeRedis();
    let now = 50_000;
    const sleeps: number[] = [];
    const waits: Array<{ stage: GroqStage; resumeAt: number | null }> = [];

    const budget = createGroqBudget({
      db: fake as unknown as BudgetStoreDb,
      now: () => now,
      seedLimits: () => ({ tpm: 6_000 }), // 100 tokens / sec
    });
    const cursors = new Map<string, number>();

    // Drain both reasoning pool models (A has 0 left -> 30s wait; B has 2,000 left -> 10s wait for 3,000 cost).
    await budget.reserve("model/a", { inputTokens: 6_000, outputTokens: 0 });
    await budget.reserve("model/b", { inputTokens: 4_000, outputTokens: 0 });

    const acquired = await acquirePoolModel({
      stage: "synthesis",
      pool: ["model/a", "model/b"],
      fallbackPool: [],
      estInputTokens: 2_000,
      maxOutputTokens: 1_000,
      budget,
      cooldownDb: () => fake as unknown as GroqCooldownDb,
      cursors,
      onWait: (stage, resumeAt) => {
        waits.push({ stage, resumeAt });
      },
      now: () => now,
      sleep: async (ms) => {
        sleeps.push(ms);
        now += ms;
      },
      random: () => 0,
    });

    // Waited 10,080ms (10s refill + 80ms jitter) for model/b, announced wait and cleared on resume!
    expect(acquired).toEqual({ modelId: "model/b", waitedMs: 10_080 });
    expect(sleeps).toEqual([10_080]);
    expect(waits).toEqual([
      { stage: "synthesis", resumeAt: 60_000 },
      { stage: "synthesis", resumeAt: null },
    ]);
  });

  it("borrows from fallbackPool when primaryPool wait exceeds preferPoolWaitMs, preserving synthesis headroom", async () => {
    const fake = new FakeRedis();
    let now = 10_000;
    const sleeps: number[] = [];
    const budget = createGroqBudget({
      db: fake as unknown as BudgetStoreDb,
      now: () => now,
      seedLimits: () => ({ tpm: 8_000 }),
    });
    const cursors = new Map<string, number>();

    // Primary summarizer is empty -> 1,500 tokens needs 11.25s (> 5s summary preferPoolWaitMs).
    await budget.reserve("sum/20b", { inputTokens: 8_000, outputTokens: 0 });
    // Reasoning overflow has 6,000 left: 1,500 + 4,000 headroom = 5,500 <= 6,000 -> granted immediately!
    await budget.reserve("reason/120b", { inputTokens: 2_000, outputTokens: 0 });

    const borrowed = await acquirePoolModel({
      stage: "summary",
      pool: ["sum/20b"],
      fallbackPool: ["reason/120b"],
      estInputTokens: 1_000,
      maxOutputTokens: 500,
      budget,
      cooldownDb: () => fake as unknown as GroqCooldownDb,
      cursors,
      synthesisReserveTokens: 4_000,
      now: () => now,
      sleep: async (ms) => {
        sleeps.push(ms);
        now += ms;
      },
    });
    expect(borrowed).toEqual({ modelId: "reason/120b", waitedMs: 0 });
    expect(sleeps).toEqual([]);

    // Drain reason/120b further (only 2,000 left < 1,500 + 4,000 reserve, needing 26.25s),
    // so auxiliary refuses to raid synthesis headroom and waits once for sum/20b (11.25s) instead!
    await budget.reserve("reason/120b", { inputTokens: 2_500, outputTokens: 0 });
    const waitedOwn = await acquirePoolModel({
      stage: "summary",
      pool: ["sum/20b"],
      fallbackPool: ["reason/120b"],
      estInputTokens: 1_000,
      maxOutputTokens: 500,
      budget,
      cooldownDb: () => fake as unknown as GroqCooldownDb,
      cursors,
      synthesisReserveTokens: 4_000,
      now: () => now,
      sleep: async (ms) => {
        sleeps.push(ms);
        now += ms;
      },
      random: () => 0,
    });
    expect(waitedOwn.modelId).toBe("sum/20b");
    expect(sleeps).toEqual([11_330]);
  });
});

describe("createRequestQueue (FIFO concurrency & waiting)", () => {
  it("admits up to maxConcurrentTurns immediately and queues excess turns in strict FIFO order", async () => {
    const fake = new FakeRedis();
    let now = 1_000;
    const positions3: Array<number | null> = [];

    const makeQueue = (onWake?: () => Promise<void>) =>
      createRequestQueue({
        db: fake as unknown as QueueDb,
        maxConcurrentTurns: 2,
        maxQueueLength: 5,
        pollMs: 2_000,
        leaseMs: 30_000,
        now: () => now,
        sleep: async (ms) => {
          now += ms;
          await onWake?.();
        },
      });

    const q = makeQueue();
    const release1 = await q.acquire("run-1");
    const release2 = await q.acquire("run-2");

    // 3rd turn waits at position 1 until run-1 releases on the second poll!
    let polls = 0;
    const q3 = makeQueue(async () => {
      polls += 1;
      if (polls === 2) await release1();
    });

    const release3 = await q3.acquire("run-3", {
      onPosition: (pos) => {
        positions3.push(pos);
      },
    });

    expect(positions3).toEqual([1, 1, null]);
    expect(now).toBe(5_000); // waited two 2s polls

    await release2();
    await release3();
  });

  it("evicts crashed turns whose lease expired and removes aborted waiters immediately", async () => {
    const fake = new FakeRedis();
    let now = 10_000;
    const q = createRequestQueue({
      db: fake as unknown as QueueDb,
      maxConcurrentTurns: 1,
      maxQueueLength: 2,
      pollMs: 1_000,
      leaseMs: 10_000,
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
    });

    // Simulate a turn that acquired the only slot and then its isolate died (no release, time passes > leaseMs).
    await q.acquire("dead-run");
    now += 15_000;

    // Next turn evicts `dead-run` and gets admitted immediately with 0 wait!
    const releaseLive = await q.acquire("live-run");
    expect(now).toBe(25_000);

    // A queued waiter that aborts frees its place immediately.
    const abortCtrl = new AbortController();
    const qAbort = createRequestQueue({
      db: fake as unknown as QueueDb,
      maxConcurrentTurns: 1,
      pollMs: 1_000,
      now: () => now,
      sleep: async () => {
        abortCtrl.abort();
      },
    });
    await expect(
      qAbort.acquire("aborted-run", { signal: abortCtrl.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });

    await releaseLive();
    expect(await fake.zcard("queue:turns:waiting")).toBe(0);
  });

  it("throws QueueBusyError when maxWaitMs is exceeded", async () => {
    const fake = new FakeRedis();
    let now = 1_000;
    const q = createRequestQueue({
      db: fake as unknown as QueueDb,
      maxConcurrentTurns: 1,
      maxWaitMs: 3_000,
      pollMs: 2_000,
      leaseMs: 60_000,
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
    });

    const release = await q.acquire("holder");
    await expect(q.acquire("timed-out")).rejects.toBeInstanceOf(QueueBusyError);
    await release();
  });
});

describe("busyLabel wait formatting", () => {
  it("renders queue positions and live rate-limit countdowns cleanly", () => {
    expect(busyLabel([], { kind: "queued", position: 1 }, 10_000)).toBe(
      "In queue — you're next…",
    );
    expect(busyLabel([], { kind: "queued", position: 3 }, 10_000)).toBe(
      "In queue (position 3)…",
    );
    expect(
      busyLabel(
        [],
        { kind: "rate-limit", stage: "answering", resumeAt: 24_200 },
        10_000,
      ),
    ).toBe("Waiting for model quota before writing the answer (15s)…");
    // Resting heartbeat (`nowMs = 0`) never flashes a billion-second epoch countdown!
    expect(
      busyLabel(
        [],
        { kind: "rate-limit", stage: "answering", resumeAt: 1_794_890_000_000 },
        0,
      ),
    ).toBe("Waiting for model quota before writing the answer…");
  });
});
