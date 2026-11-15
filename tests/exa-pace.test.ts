import { afterEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.EXA_REQUESTS_PER_SECOND = "0";
  process.env.EXA_API_KEY = "test-key";
});

import { createMemoryBucketStore } from "@/lib/agent/token-bucket";
import { createRequestCache, type CacheStore } from "@/lib/cache";
import { awaitExaRateSlot, createExaClient } from "@/lib/exa";

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

function memoryCache() {
  const data = new Map<string, string>();
  const store: CacheStore = {
    get: async (k) => data.get(k) ?? null,
    set: async (k, v) => {
      data.set(k, v);
    },
  };
  return createRequestCache(store);
}

describe("createExaClient", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("caches search results and sends full-document highlights, 20k maxCharacters, and structured EXACT:/RECENT: operators", async () => {
    const seenPayloads: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", async (_url: unknown, init?: RequestInit) => {
      seenPayloads.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(
        JSON.stringify({
          results: [
            {
              url: "https://arxiv.org/abs/2601.00001",
              title: "Paper",
              text: "Main body",
              highlights: ["Deep table result: 99.1% accuracy on page 34."],
            },
          ],
        }),
      );
    });

    const client = createExaClient({ cache: memoryCache() });
    const reqOpts = {
      maxCharacters: 20_000,
      highlightsQuery: "HBM4 pin bandwidth and JEDEC JESD270 specs",
    };

    const out = await client.searchDetailed(
      "RECENT[30d]: EXACT: HBM4 JEDEC JESD270",
      8,
      reqOpts,
    );
    const cachedHit = await client.searchDetailed(
      "RECENT[30d]: EXACT: HBM4 JEDEC JESD270",
      8,
      reqOpts,
    );

    expect(out.error).toBeUndefined();
    expect(cachedHit.docs).toEqual(out.docs);
    expect(out.docs[0].highlights).toEqual([
      "Deep table result: 99.1% accuracy on page 34.",
    ]);
    // Second identical call served from cache with no second upstream fetch.
    expect(seenPayloads).toHaveLength(1);
    expect(seenPayloads[0]).toMatchObject({
      query: "HBM4 JEDEC JESD270",
      type: "keyword",
      numResults: 8,
      startPublishedDate: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      contents: {
        text: { maxCharacters: 20_000 },
        highlights: {
          query: "HBM4 pin bandwidth and JEDEC JESD270 specs",
          numSentences: 4,
          highlightsPerUrl: 4,
        },
      },
    });
  });
});
