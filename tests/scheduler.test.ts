import { describe, expect, it } from "vitest";
import { createGroqBudget } from "@/lib/agent/groq-budget";
import type { GroqCooldownDb } from "@/lib/agent/groq-rate-limit";
import {
  createModelScheduler,
  isDenied,
  type SchedulerStatus,
} from "@/lib/agent/scheduler";
import { createMemoryBucketStore } from "@/lib/agent/token-bucket";
import { FakeRedis } from "./fake-redis";

const PRIMARY = "model/primary";
const FALLBACK = "model/fallback";

/** Scheduler over an in-memory budget with a controllable clock. */
function setup(opts?: {
  limits?: Record<string, { tpm?: number; itpm?: number; otpm?: number }>;
  waitMs?: number;
  reserveTokens?: number;
  db?: FakeRedis;
}) {
  const clock = { now: 1_000_000 };
  const sleeps: number[] = [];
  const statuses: SchedulerStatus[] = [];
  const limits = opts?.limits ?? { [PRIMARY]: { tpm: 6_000 }, [FALLBACK]: { tpm: 6_000 } };
  const budget = createGroqBudget({
    store: createMemoryBucketStore(),
    now: () => clock.now,
    seedLimits: (model) => limits[model],
  });
  const scheduler = createModelScheduler({
    budget,
    cooldownDb: () => opts?.db as unknown as GroqCooldownDb | undefined,
    onStatus: (s) => statuses.push(s),
    stageWaitMs: () => opts?.waitMs ?? 30_000,
    synthesisReserveTokens: opts?.reserveTokens ?? 0,
    now: () => clock.now,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock.now += ms;
    },
    random: () => 0,
  });
  return { clock, sleeps, statuses, budget, scheduler };
}

const request = (over?: Partial<Parameters<ReturnType<typeof setup>["scheduler"]["acquire"]>[0]>) => ({
  stage: "summary" as const,
  candidates: [PRIMARY, FALLBACK],
  estInputTokens: 2_000,
  maxOutputTokens: 1_000,
  ...over,
});

describe("createModelScheduler", () => {
  it("waits visibly for the primary when the wait fits, instead of switching model", async () => {
    const { scheduler, sleeps, statuses, clock } = setup();
    await scheduler.acquire(request()); // 3,000 of 6,000 left
    await scheduler.acquire(request()); // 0 left
    const started = clock.now;
    const result = await scheduler.acquire(request());
    // 3,000 tokens at 100/s = 30s, plus the minimum 50ms jitter.
    expect(result).toEqual({ model: PRIMARY, waitedMs: 30_050 });
    expect(sleeps).toEqual([30_050]);
    expect(statuses).toEqual([
      { kind: "waiting", stage: "summary", model: PRIMARY, resumeAt: started + 30_000 },
      { kind: "resumed", stage: "summary" },
    ]);
  });

  it("switches to a free fallback when the primary's wait exceeds the stage cap", async () => {
    const { scheduler, sleeps } = setup({ waitMs: 5_000 });
    await scheduler.acquire(request({ candidates: [PRIMARY] }));
    await scheduler.acquire(request({ candidates: [PRIMARY] }));
    expect(await scheduler.acquire(request())).toEqual({ model: FALLBACK, waitedMs: 0 });
    expect(sleeps).toEqual([]);
  });

  it("keeps a synthesis-sized reserve free when an auxiliary stage borrows a fallback", async () => {
    const { scheduler, budget } = setup({ waitMs: 0, reserveTokens: 4_000 });
    await budget.reserve(PRIMARY, { inputTokens: 6_000, outputTokens: 0 });
    await budget.reserve(FALLBACK, { inputTokens: 1_000, outputTokens: 0 });
    // Fallback has 5,000 left: 3,000 + the 4,000 reserve does not fit, so
    // the auxiliary stage is refused...
    const aux = await scheduler.acquire(request());
    expect(isDenied(aux)).toBe(true);
    // ...but the answer itself may use the whole window.
    const synthesis = await scheduler.acquire(request({ stage: "synthesis" }));
    expect(synthesis).toEqual({ model: FALLBACK, waitedMs: 0 });
  });

  it("waits for whichever candidate frees up soonest when none is free", async () => {
    const { scheduler, budget, sleeps } = setup({ waitMs: 12_000 });
    await budget.reserve(PRIMARY, { inputTokens: 6_000, outputTokens: 0 }); // 30s away
    await budget.reserve(FALLBACK, { inputTokens: 4_000, outputTokens: 0 }); // 10s away
    const result = await scheduler.acquire(request());
    expect(result).toMatchObject({ model: FALLBACK });
    expect(sleeps).toEqual([10_050]);
  });

  it("denies with the shortest wait when nothing fits the cap", async () => {
    const { scheduler, budget, sleeps } = setup({ waitMs: 5_000 });
    await budget.reserve(PRIMARY, { inputTokens: 6_000, outputTokens: 0 });
    await budget.reserve(FALLBACK, { inputTokens: 4_000, outputTokens: 0 });
    expect(await scheduler.acquire(request())).toEqual({ denied: true, waitMs: 10_000 });
    expect(sleeps).toEqual([]);
  });

  it("re-checks the budget after sleeping rather than assuming the window is free", async () => {
    const { scheduler, budget, sleeps, clock } = setup({ waitMs: 60_000 });
    await budget.reserve(PRIMARY, { inputTokens: 6_000, outputTokens: 0 });
    let stolen = false;
    const acquire = scheduler.acquire(request({ candidates: [PRIMARY] }));
    // Another turn takes the refilled tokens while this one is asleep.
    const originalReserve = budget.reserve.bind(budget);
    budget.reserve = async (model, cost, o) => {
      if (!stolen && clock.now > 1_000_000) {
        stolen = true;
        await originalReserve(model, { inputTokens: 2_000, outputTokens: 0 });
      }
      return originalReserve(model, cost, o);
    };
    const result = await acquire;
    expect(result).toMatchObject({ model: PRIMARY });
    expect(sleeps).toHaveLength(2);
  });

  it("honours per-model output reservations across separate input/output limits", async () => {
    const { scheduler } = setup({
      limits: { [PRIMARY]: { tpm: 8_000, itpm: 7_000, otpm: 1_000 } },
      waitMs: 0,
    });
    const req = request({
      candidates: [PRIMARY],
      maxOutputTokens: (model: string) => (model === PRIMARY ? 900 : 3_500),
    });
    expect(await scheduler.acquire(req)).toEqual({ model: PRIMARY, waitedMs: 0 });
    // Output window (1,000/min) has 100 left; 900 needs 48s.
    expect(await scheduler.acquire(req)).toEqual({ denied: true, waitMs: 48_000 });
  });

  it("skips a model on a daily cooldown and waits out a short one", async () => {
    const db = new FakeRedis();
    const { scheduler, clock, sleeps } = setup({ db, waitMs: 8_000 });
    db.strings.set(`ratelimit:groq:cooldown:${PRIMARY}`, `daily:${clock.now + 5_000}`);
    expect(await scheduler.acquire(request())).toEqual({ model: FALLBACK, waitedMs: 0 });

    db.strings.set(`ratelimit:groq:cooldown:${PRIMARY}`, String(clock.now + 5_000));
    const result = await scheduler.acquire(request());
    expect(result).toMatchObject({ model: PRIMARY });
    expect(sleeps).toEqual([5_050]);
  });

  it("leaves unknown models unbudgeted", async () => {
    const { scheduler } = setup({ limits: {} });
    for (let i = 0; i < 5; i++) {
      expect(await scheduler.acquire(request({ estInputTokens: 50_000 }))).toEqual({
        model: PRIMARY,
        waitedMs: 0,
      });
    }
  });

  it("honours per-request maxWaitMs overrides for patient high-effort stages", async () => {
    const { scheduler, sleeps } = setup({ waitMs: 5_000 });
    await scheduler.acquire(request({ candidates: [PRIMARY] })); // 3,000 left
    await scheduler.acquire(request({ candidates: [PRIMARY] })); // 0 left (needs 30s)

    // Default 5s cap denies when only PRIMARY is eligible (and switches to FALLBACK when available):
    expect(await scheduler.acquire(request({ candidates: [PRIMARY] }))).toEqual({
      denied: true,
      waitMs: 30_000,
    });
    expect(sleeps).toEqual([]);

    // Patient 45s override waits for PRIMARY's bucket to refill instead of switching to FALLBACK:
    const granted = await scheduler.acquire(request({ maxWaitMs: 45_000 }));
    expect(granted).toEqual({ model: PRIMARY, waitedMs: 30_050 });
    expect(sleeps).toEqual([30_050]);
  });

  it("rejects with AbortError when the turn is stopped mid-wait", async () => {
    const controller = new AbortController();
    const budget = createGroqBudget({
      store: createMemoryBucketStore(),
      seedLimits: () => ({ tpm: 6_000 }),
    });
    await budget.reserve(PRIMARY, { inputTokens: 6_000, outputTokens: 0 });
    const scheduler = createModelScheduler({
      budget,
      stageWaitMs: () => 60_000,
      sleep: () => new Promise(() => {}),
    });
    const pending = scheduler.acquire(request({ candidates: [PRIMARY], signal: controller.signal }));
    setTimeout(() => controller.abort(), 5);
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("createGroqBudget.observe", () => {
  it("lowers the combined window to the header value and learns the real limit", async () => {
    const clock = { now: 0 };
    const budget = createGroqBudget({
      store: createMemoryBucketStore(),
      now: () => clock.now,
      seedLimits: () => ({ tpm: 6_000 }),
    });
    await budget.observe(PRIMARY, { limitTokens: 12_000, remainingTokens: 500 });
    expect(budget.limitsFor(PRIMARY)).toEqual({ tpm: 12_000 });
    // 500 left at 200 tokens/s: 1,500 needs 5s.
    expect(await budget.reserve(PRIMARY, { inputTokens: 1_500, outputTokens: 0 })).toEqual({
      granted: false,
      waitMs: 5_000,
    });
  });

  it("empties only the window a 429 names", async () => {
    const budget = createGroqBudget({
      store: createMemoryBucketStore(),
      now: () => 0,
      seedLimits: () => ({ tpm: 8_000, itpm: 7_000, otpm: 1_000 }),
    });
    await budget.observe(PRIMARY, { exhausted: "otpm" });
    expect((await budget.reserve(PRIMARY, { inputTokens: 5_000, outputTokens: 0 })).granted).toBe(true);
    expect(await budget.reserve(PRIMARY, { inputTokens: 0, outputTokens: 100 })).toEqual({
      granted: false,
      waitMs: 6_000,
    });
  });
});