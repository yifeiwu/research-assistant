import { describe, expect, it } from "vitest";
import { createMemoryBucketStore } from "@/lib/agent/token-bucket";
import { awaitExaRateSlot } from "@/lib/exa";

function setup(over?: { requestsPerSecond?: number; burst?: number; maxWaitMs?: number }) {
  const clock = { now: 50_000 };
  const store = createMemoryBucketStore();
  const sleeps: number[] = [];
  const take = (signal?: AbortSignal) =>
    awaitExaRateSlot({
      store,
      requestsPerSecond: over?.requestsPerSecond ?? 4,
      burst: over?.burst ?? 2,
      maxWaitMs: over?.maxWaitMs ?? 5_000,
      now: () => clock.now,
      sleep: async (ms) => {
        sleeps.push(ms);
        clock.now += ms;
      },
      signal,
    });
  return { clock, sleeps, take };
}

describe("awaitExaRateSlot", () => {
  it("never sends more than rate + burst calls in any one second", async () => {
    const { take, clock } = setup({ requestsPerSecond: 8, burst: 2 });
    const sentAt: number[] = [];
    for (let i = 0; i < 40; i++) {
      await take();
      sentAt.push(clock.now);
    }
    for (const t of sentAt) {
      const inWindow = sentAt.filter((s) => s >= t && s < t + 1_000).length;
      expect(inWindow).toBeLessThanOrEqual(10);
    }
  });

  it("goes ahead without a slot when the wait would exceed the cap", async () => {
    const { take, sleeps } = setup({ requestsPerSecond: 1, burst: 1, maxWaitMs: 500 });
    await take();
    expect(await take()).toBe(0); // next slot is 1s away, over the 500ms cap
    expect(sleeps).toEqual([]);
  });

  it("is disabled by a rate of 0", async () => {
    const { take, sleeps } = setup({ requestsPerSecond: 0 });
    for (let i = 0; i < 20; i++) expect(await take()).toBe(0);
    expect(sleeps).toEqual([]);
  });

  it("stops waiting when the request is aborted", async () => {
    const { take } = setup({ requestsPerSecond: 1, burst: 1 });
    const controller = new AbortController();
    controller.abort();
    await expect(take(controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  });
});
