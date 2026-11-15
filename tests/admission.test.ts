import { describe, expect, it } from "vitest";
import {
  createAdmissionQueue,
  createMemoryAdmissionStore,
  type AdmissionStore,
  type AdmissionTicket,
} from "@/lib/agent/admission";

const LIMITS = { maxActive: 2, maxQueue: 2, leaseMs: 30_000, ticketTtlMs: 20_000 };

const ticket = (id: string, enqueuedAt: number): AdmissionTicket => ({ id, enqueuedAt });

describe("createMemoryAdmissionStore", () => {
  it("grants up to maxActive and queues the rest in arrival order", async () => {
    const store = createMemoryAdmissionStore();
    expect(await store.poll(ticket("a", 1), 100, LIMITS)).toEqual({ state: "granted" });
    expect(await store.poll(ticket("b", 2), 100, LIMITS)).toEqual({ state: "granted" });
    expect(await store.poll(ticket("c", 3), 100, LIMITS)).toEqual({ state: "queued", position: 1 });
    expect(await store.poll(ticket("d", 4), 100, LIMITS)).toEqual({ state: "queued", position: 2 });
  });

  it("rejects new tickets once the queue is full, without evicting anyone", async () => {
    const store = createMemoryAdmissionStore();
    for (const [id, at] of [["a", 1], ["b", 2], ["c", 3], ["d", 4]] as const) {
      await store.poll(ticket(id, at), 100, LIMITS);
    }
    expect(await store.poll(ticket("e", 5), 100, LIMITS)).toEqual({ state: "full", queueLength: 2 });
    // Tickets already queued keep their place.
    expect(await store.poll(ticket("d", 4), 100, LIMITS)).toEqual({ state: "queued", position: 2 });
  });

  it("is first-in first-out: a later ticket cannot overtake when a slot frees", async () => {
    const store = createMemoryAdmissionStore();
    await store.poll(ticket("a", 1), 100, LIMITS);
    await store.poll(ticket("b", 2), 100, LIMITS);
    await store.poll(ticket("c", 3), 100, LIMITS);
    await store.poll(ticket("d", 4), 100, LIMITS);
    await store.release("a");

    // `d` polls first but `c` is ahead of it.
    expect(await store.poll(ticket("d", 4), 200, LIMITS)).toEqual({ state: "queued", position: 2 });
    expect(await store.poll(ticket("c", 3), 200, LIMITS)).toEqual({ state: "granted" });
    expect(await store.poll(ticket("d", 4), 200, LIMITS)).toEqual({ state: "queued", position: 1 });
  });

  it("frees a slot whose lease was not renewed", async () => {
    const store = createMemoryAdmissionStore();
    await store.poll(ticket("a", 1), 0, LIMITS);
    await store.poll(ticket("b", 2), 0, LIMITS);
    await store.poll(ticket("c", 3), 0, LIMITS);

    await store.renew("b", 20_000, LIMITS.leaseMs); // `a` is never renewed
    expect(await store.poll(ticket("c", 3), 29_999, LIMITS)).toEqual({ state: "queued", position: 1 });
    expect(await store.poll(ticket("c", 3), 30_000, LIMITS)).toEqual({ state: "granted" });
  });

  it("drops a queued ticket that stopped polling, so it cannot block the line", async () => {
    const store = createMemoryAdmissionStore();
    await store.poll(ticket("a", 1), 0, LIMITS);
    await store.poll(ticket("b", 2), 0, LIMITS);
    await store.poll(ticket("c", 3), 0, LIMITS); // abandoned
    await store.poll(ticket("d", 4), 0, LIMITS);

    await store.poll(ticket("d", 4), 15_000, LIMITS); // `d` keeps polling
    await store.release("a");
    // `c` expired at 20s, so `d` is now first and takes the free slot.
    expect(await store.poll(ticket("d", 4), 21_000, LIMITS)).toEqual({ state: "granted" });
  });

  it("re-admits a released ticket at its original place in line", async () => {
    const store = createMemoryAdmissionStore();
    await store.poll(ticket("a", 1), 0, LIMITS);
    await store.poll(ticket("b", 2), 0, LIMITS);
    await store.poll(ticket("c", 3), 0, LIMITS);
    await store.release("a"); // e.g. a detached turn deferring
    // `a` comes back: it arrived before `c`, so it goes ahead of it.
    expect(await store.poll(ticket("a", 1), 100, LIMITS)).toEqual({ state: "granted" });
    expect(await store.poll(ticket("c", 3), 100, LIMITS)).toEqual({ state: "queued", position: 1 });
  });
});

describe("createAdmissionQueue", () => {
  function setup(opts?: { store?: AdmissionStore; maxConcurrentTurns?: number }) {
    const store = opts?.store ?? createMemoryAdmissionStore();
    const queue = createAdmissionQueue({
      store,
      config: { maxConcurrentTurns: opts?.maxConcurrentTurns ?? 1, maxQueueLength: 5 },
      now: () => 0,
    });
    return { store, queue };
  }

  it("moves a queued turn up as those ahead leave, and admits it when a held slot is released", async () => {
    const { queue } = setup();
    const a = ticket("a", 1);
    const b = ticket("b", 2);
    const c = ticket("c", 3);
    expect(await queue.poll(a)).toEqual({ state: "granted" });
    const releaseA = queue.hold(a);
    await queue.poll(b);
    expect(await queue.poll(c)).toEqual({ state: "queued", position: 2 });

    await queue.cancel(b);
    expect(await queue.poll(c)).toEqual({ state: "queued", position: 1 });
    await releaseA();
    expect(await queue.poll(c)).toEqual({ state: "granted" });
  });

  it("fails open when the store is unavailable", async () => {
    const broken: AdmissionStore = {
      poll: async () => {
        throw new Error("redis down");
      },
      renew: async () => {
        throw new Error("redis down");
      },
      release: async () => {
        throw new Error("redis down");
      },
    };
    const { queue } = setup({ store: broken });
    const t = ticket("a", 1);
    expect(await queue.poll(t)).toEqual({ state: "granted" });
    await expect(queue.hold(t)()).resolves.toBeUndefined();
    await expect(queue.cancel(t)).resolves.toBeUndefined();
  });

  it("admits everything without touching the store when disabled", async () => {
    const untouched: AdmissionStore = {
      poll: async () => {
        throw new Error("should not be called");
      },
      renew: async () => {},
      release: async () => {
        throw new Error("should not be called");
      },
    };
    const { queue } = setup({ store: untouched, maxConcurrentTurns: 0 });
    expect(queue.enabled).toBe(false);
    expect(await queue.poll(ticket("a", 1))).toEqual({ state: "granted" });
    await queue.hold(ticket("a", 1))();
  });
});
