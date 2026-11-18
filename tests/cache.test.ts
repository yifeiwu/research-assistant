import { describe, expect, it, vi } from "vitest";
import { createRequestCache, type CacheStore } from "@/lib/cache";

function fakeStore(fail = false): CacheStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    get: async (k) => {
      if (fail) throw new Error("redis down");
      return data.get(k) ?? null;
    },
    set: async (k, v) => {
      if (fail) throw new Error("redis down");
      data.set(k, v);
    },
  };
}

describe("request cache", () => {
  it("serves the second call from cache", async () => {
    const cache = createRequestCache(fakeStore());
    const loader = vi.fn(async () => ({ docs: [1] }));
    const a = await cache.wrap("search", { q: "x" }, 60, loader);
    const b = await cache.wrap("search", { q: "x" }, 60, loader);
    expect(a).toEqual(b);
    expect(loader).toHaveBeenCalledTimes(1);
  });
  it("coalesces concurrent misses", async () => {
    const cache = createRequestCache(fakeStore());
    const loader = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 10));
      return 42;
    });
    const [a, b] = await Promise.all([
      cache.wrap("search", { q: "y" }, 60, loader),
      cache.wrap("search", { q: "y" }, 60, loader),
    ]);
    expect(a).toBe(42);
    expect(b).toBe(42);
    expect(loader).toHaveBeenCalledTimes(1);
  });
  it("serves hits when the store returns already-deserialized values (Upstash behaviour)", async () => {
    // Mimics @upstash/redis: values are stored as JSON text but `get`
    // auto-deserializes them back to objects/arrays/plain strings.
    const data = new Map<string, string>();
    const store: CacheStore = {
      get: async (k) => {
        const raw = data.get(k);
        if (raw == null) return null;
        try {
          return JSON.parse(raw) as unknown;
        } catch {
          return raw;
        }
      },
      set: async (k, v) => {
        data.set(k, v);
      },
    };
    const cache = createRequestCache(store);
    const objLoader = vi.fn(async () => ({ docs: [1, 2] }));
    expect(await cache.wrap("search", { q: "obj" }, 60, objLoader)).toEqual({ docs: [1, 2] });
    expect(await cache.wrap("search", { q: "obj" }, 60, objLoader)).toEqual({ docs: [1, 2] });
    expect(objLoader).toHaveBeenCalledTimes(1);

    const arrLoader = vi.fn(async () => ["note", null] as (string | null)[]);
    expect(await cache.wrap("notes-batch", { q: "arr" }, 60, arrLoader)).toEqual(["note", null]);
    expect(await cache.wrap("notes-batch", { q: "arr" }, 60, arrLoader)).toEqual(["note", null]);
    expect(arrLoader).toHaveBeenCalledTimes(1);

    const strLoader = vi.fn(async () => "plain note text");
    expect(await cache.wrap("notes", { q: "str" }, 60, strLoader)).toBe("plain note text");
    expect(await cache.wrap("notes", { q: "str" }, 60, strLoader)).toBe("plain note text");
    expect(strLoader).toHaveBeenCalledTimes(1);
  });
  it("fails open when Redis errors", async () => {
    const cache = createRequestCache(fakeStore(true));
    await expect(cache.wrap("search", { q: "z" }, 60, async () => "live")).resolves.toBe("live");
  });
  it("one caller's abort detaches only that caller from a coalesced task", async () => {
    const cache = createRequestCache(fakeStore());
    const loader = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 20));
      return 42;
    });
    const ctrl = new AbortController();
    const first = cache.wrap("search", { q: "shared" }, 60, loader, { signal: ctrl.signal });
    const second = cache.wrap("search", { q: "shared" }, 60, loader);
    ctrl.abort();
    await expect(first).rejects.toMatchObject({ name: "AbortError" });
    await expect(second).resolves.toBe(42);
    expect(loader).toHaveBeenCalledTimes(1);
  });
  it("aborts the underlying loader immediately when all attached waiters abort", async () => {
    const cache = createRequestCache(fakeStore());
    let loaderSignalAborted = false;
    const loader = vi.fn(
      (signal: AbortSignal) =>
        new Promise<number>((_, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              loaderSignalAborted = true;
              const err = new Error("Aborted");
              err.name = "AbortError";
              reject(err);
            },
            { once: true },
          );
        }),
    );
    const ctrl = new AbortController();
    const pending = cache.wrap("notes-batch", { q: "cancel-me" }, 60, loader, {
      signal: ctrl.signal,
    });
    await new Promise((r) => setTimeout(r, 5));
    ctrl.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(loaderSignalAborted).toBe(true);
  });
  it("skips writing partial results to Redis when shouldCache returns false", async () => {
    const store = fakeStore();
    const cache = createRequestCache(store);
    let call = 0;
    const loader = vi.fn(async () =>
      ++call === 1 ? (["note-1", null] as (string | null)[]) : (["note-1", "note-2"] as (string | null)[]),
    );
    const shouldCache = (notes: (string | null)[]) => notes.every((n) => n !== null);

    const first = await cache.wrap("notes-batch", { q: "partial" }, 60, loader, {
      shouldCache,
    });
    expect(first).toEqual(["note-1", null]);
    expect(store.data.size).toBe(0);

    const second = await cache.wrap("notes-batch", { q: "partial" }, 60, loader, {
      shouldCache,
    });
    expect(second).toEqual(["note-1", "note-2"]);
    expect(store.data.size).toBe(1);
    expect(loader).toHaveBeenCalledTimes(2);
  });
});
