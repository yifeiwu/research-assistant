import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Read when lib/config is first imported: switch the shared req/s pacing off
// so only the per-thread limit is under test.
vi.hoisted(() => {
  process.env.EXA_REQUESTS_PER_SECOND = "0";
  process.env.EXA_API_KEY = "test-key";
});

import { createRequestCache, type CacheStore } from "@/lib/cache";
import { createExaClient } from "@/lib/exa";

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

/** Stands in for Exa: each call stays in flight until the test finishes it. */
function fakeExa() {
  const inFlight: Array<{ query: string; finish: () => void }> = [];
  let maxInFlight = 0;
  const fetchImpl = async (_url: unknown, init?: RequestInit) => {
    const { query } = JSON.parse(String(init?.body)) as { query: string };
    await new Promise<void>((resolve) => {
      inFlight.push({ query, finish: resolve });
      maxInFlight = Math.max(maxInFlight, inFlight.length);
    });
    return new Response(
      JSON.stringify({ results: [{ url: `https://ex.com/${query}`, title: query, text: "body" }] }),
    );
  };
  const finishOne = () => {
    const call = inFlight.shift();
    if (!call) throw new Error("no Exa call in flight");
    call.finish();
  };
  return {
    fetchImpl,
    queries: () => inFlight.map((c) => c.query),
    finishOne,
    maxInFlight: () => maxInFlight,
  };
}

/** Long enough for anything that is going to start to have started. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

describe("Exa searches per conversation thread", () => {
  let exa: ReturnType<typeof fakeExa>;

  beforeEach(() => {
    exa = fakeExa();
    vi.stubGlobal("fetch", exa.fetchImpl);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("runs at most 2 at a time for a thread, even across separate runs of it", async () => {
    const cache = memoryCache();
    // Two clients on one thread, e.g. a superseded run that is still
    // finishing and the turn that replaced it.
    const first = createExaClient({ threadId: "thread-a", cache });
    const second = createExaClient({ threadId: "thread-a", cache });
    const all = Promise.all([
      first.searchDetailed("a1", 4),
      first.searchDetailed("a2", 4),
      first.searchDetailed("a3", 4),
      second.searchDetailed("a4", 4),
      second.searchDetailed("a5", 4),
    ]);

    await settle();
    expect(exa.queries()).toEqual(["a1", "a2"]);

    // Each finished call lets exactly one waiting call start.
    for (let done = 0; done < 5; done++) {
      await vi.waitFor(() => expect(exa.queries().length).toBeGreaterThan(0));
      exa.finishOne();
      await settle();
    }
    const outcomes = await all;
    expect(outcomes.every((o) => o.docs.length === 1 && !o.error)).toBe(true);
    expect(exa.maxInFlight()).toBe(2);
  });

  it("does not make one thread wait for another", async () => {
    const cache = memoryCache();
    const a = createExaClient({ threadId: "thread-a", cache });
    const b = createExaClient({ threadId: "thread-b", cache });
    const all = Promise.all([
      a.searchDetailed("a1", 4),
      a.searchDetailed("a2", 4),
      a.searchDetailed("a3", 4),
      b.searchDetailed("b1", 4),
    ]);

    await settle();
    // Thread A is at its limit with a3 waiting; thread B's search still runs.
    expect(exa.queries()).toEqual(["a1", "a2", "b1"]);

    for (let done = 0; done < 4; done++) {
      await vi.waitFor(() => expect(exa.queries().length).toBeGreaterThan(0));
      exa.finishOne();
      await settle();
    }
    await all;
  });

  it("answers from the cache without waiting for a slot", async () => {
    const cache = memoryCache();
    const client = createExaClient({ threadId: "thread-a", cache });

    const warm = client.searchDetailed("cached", 4);
    await settle();
    exa.finishOne();
    await warm;

    // Fill both of the thread's slots with calls that are still in flight.
    const busy = Promise.all([client.searchDetailed("slow1", 4), client.searchDetailed("slow2", 4)]);
    await settle();
    expect(exa.queries()).toEqual(["slow1", "slow2"]);

    const hit = await client.searchDetailed("cached", 4);
    expect(hit.docs).toHaveLength(1);
    expect(exa.queries()).toEqual(["slow1", "slow2"]);

    exa.finishOne();
    exa.finishOne();
    await busy;
  });
});
