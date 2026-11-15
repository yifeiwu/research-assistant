import { describe, expect, it } from "vitest";
import {
  createFailOpenBucketStore,
  createMemoryBucketStore,
  perMinute,
  type BucketStore,
} from "@/lib/agent/token-bucket";

const tpm = (key: string, cost: number, limit = 6_000, headroom?: number) => ({
  key,
  cost,
  headroom,
  ...perMinute(limit),
});

describe("memory bucket store", () => {
  it("grants until the bucket is empty, then reports how long until it fits", async () => {
    const store = createMemoryBucketStore();
    expect(await store.reserve([tpm("a", 4_000)], 0)).toEqual({ granted: true, waitMs: 0 });
    // 2,000 left; 3,000 needs another 1,000 at 100 tokens/s = 10s.
    expect(await store.reserve([tpm("a", 3_000)], 0)).toEqual({ granted: false, waitMs: 10_000 });
    // A denied reservation debits nothing.
    expect(await store.reserve([tpm("a", 2_000)], 0)).toEqual({ granted: true, waitMs: 0 });
  });

  it("refills continuously and never above capacity", async () => {
    const store = createMemoryBucketStore();
    await store.reserve([tpm("a", 6_000)], 0);
    expect((await store.reserve([tpm("a", 1_000)], 5_000)).granted).toBe(false);
    expect((await store.reserve([tpm("a", 1_000)], 10_000)).granted).toBe(true);
    // Long idle: back to a full bucket, not more.
    expect((await store.reserve([tpm("a", 6_000)], 10_000_000)).granted).toBe(true);
    expect((await store.reserve([tpm("a", 1)], 10_000_000)).granted).toBe(false);
  });

  it("is all-or-nothing across several buckets and waits for the slowest", async () => {
    const store = createMemoryBucketStore();
    await store.reserve([tpm("out", 900, 1_000)], 0);
    const res = await store.reserve([tpm("total", 3_000, 8_000), tpm("out", 350, 1_000)], 0);
    // "out" has 100 left and needs 250 more at 1,000/min.
    expect(res).toEqual({ granted: false, waitMs: 15_000 });
    // "total" was not debited by the failed attempt.
    expect((await store.reserve([tpm("total", 8_000, 8_000)], 0)).granted).toBe(true);
  });

  it("requires headroom to remain after the debit without spending it", async () => {
    const store = createMemoryBucketStore();
    await store.reserve([tpm("a", 3_000, 8_000)], 0);
    // 5,000 left: 800 + 4,000 headroom fits, and only 800 is taken.
    expect((await store.reserve([tpm("a", 800, 8_000, 4_000)], 0)).granted).toBe(true);
    // 4,200 left: 800 + 4,000 no longer fits.
    expect((await store.reserve([tpm("a", 800, 8_000, 4_000)], 0)).granted).toBe(false);
    expect((await store.reserve([tpm("a", 4_200, 8_000)], 0)).granted).toBe(true);
  });

  it("clamps an oversize cost to capacity so it can still be granted", async () => {
    const store = createMemoryBucketStore();
    expect((await store.reserve([tpm("a", 50_000)], 0)).granted).toBe(true);
    expect(await store.reserve([tpm("a", 50_000)], 0)).toEqual({ granted: false, waitMs: 60_000 });
  });

  it("clamp only ever lowers a bucket", async () => {
    const store = createMemoryBucketStore();
    const ref = { key: "a", ...perMinute(6_000) };
    await store.clamp(ref, 1_000, 0);
    expect((await store.reserve([tpm("a", 1_001)], 0)).granted).toBe(false);
    // A higher reading does not hand tokens back.
    await store.clamp(ref, 6_000, 0);
    expect((await store.reserve([tpm("a", 1_001)], 0)).granted).toBe(false);
    expect((await store.reserve([tpm("a", 1_000)], 0)).granted).toBe(true);
  });
});

describe("fail-open bucket store", () => {
  it("falls back to the in-process store when the shared one errors", async () => {
    const broken: BucketStore = {
      reserve: async () => {
        throw new Error("redis down");
      },
      clamp: async () => {
        throw new Error("redis down");
      },
    };
    const store = createFailOpenBucketStore(() => broken);
    expect((await store.reserve([tpm("a", 6_000)], 0)).granted).toBe(true);
    // The fallback still enforces a (per-process) limit.
    expect((await store.reserve([tpm("a", 1)], 0)).granted).toBe(false);
    await expect(store.clamp({ key: "a", ...perMinute(6_000) }, 0, 0)).resolves.toBeUndefined();
  });
});
