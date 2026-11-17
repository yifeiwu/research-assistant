import "server-only";
import { createHash } from "node:crypto";
import { createAbortError, isAbortError } from "./errors";
import { decodeStoredJson } from "./json";
import { redis } from "./redis";
import { logDebug, logError } from "./logger";

export type CacheStore = {
  /** May return a raw string or an already-deserialized value (see below). */
  get: (key: string) => Promise<unknown>;
  set: (key: string, value: string, ttlSeconds: number) => Promise<unknown>;
};

function defaultStore(): CacheStore {
  const db = redis();
  return {
    get: (key) => db.get(key),
    set: (key, value, ttlSeconds) => db.set(key, value, { ex: ttlSeconds }),
  };
}

function cacheKey(namespace: string, parts: unknown): string {
  const hash = createHash("sha256")
    .update(JSON.stringify(parts))
    .digest("hex")
    .slice(0, 32);
  return `cache:v1:${namespace}:${hash}`;
}

export function normalizeCacheText(text: string): string {
  return text.trim().replace(/\s+/g, " ").toLowerCase();
}

export type RequestCache = {
  wrap<T>(
    namespace: string,
    parts: unknown,
    ttlSeconds: number,
    loader: (signal: AbortSignal) => Promise<T>,
    opts?: { bypass?: boolean; requestId?: string; signal?: AbortSignal },
  ): Promise<T>;
};

type InflightEntry = {
  task: Promise<unknown>;
  controller: AbortController;
  waiters: number;
};

/**
 * Await a shared task with reference-counted cancellation:
 * - Rejects promptly if *this* caller's `signal` aborts.
 * - Keeps the underlying `loader` alive while at least one other waiter is
 *   still attached, and aborts `entry.controller` immediately once *all*
 *   waiters have aborted so cancelled turns never leak background LLM/Exa calls.
 */
function attachWaiter<T>(
  entry: InflightEntry,
  signal?: AbortSignal,
): Promise<T> {
  if (signal?.aborted) {
    if (entry.waiters === 0) entry.controller.abort();
    return Promise.reject(createAbortError());
  }
  entry.waiters += 1;
  let detached = false;
  const release = (aborted: boolean) => {
    if (detached) return;
    detached = true;
    entry.waiters = Math.max(0, entry.waiters - 1);
    if (aborted && entry.waiters === 0) {
      entry.controller.abort();
    }
  };

  if (!signal) {
    return (entry.task as Promise<T>).finally(() => release(false));
  }

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      release(true);
      reject(createAbortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    (entry.task as Promise<T>).then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        release(false);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        release(false);
        reject(error);
      },
    );
  });
}

/**
 * Fail-open Redis cache with reference-counted in-flight coalescing.
 */
export function createRequestCache(store?: CacheStore): RequestCache {
  const inflight = new Map<string, InflightEntry>();
  return {
    async wrap(namespace, parts, ttlSeconds, loader, opts) {
      if (opts?.signal?.aborted) {
        throw createAbortError();
      }
      if (opts?.bypass || ttlSeconds <= 0) {
        const directController = new AbortController();
        const directEntry: InflightEntry = {
          task: Promise.resolve().then(() => loader(directController.signal)),
          controller: directController,
          waiters: 0,
        };
        return attachWaiter(directEntry, opts?.signal);
      }

      const key = cacheKey(namespace, parts);
      const pending = inflight.get(key);
      if (pending && !pending.controller.signal.aborted) {
        return attachWaiter<Awaited<ReturnType<typeof loader>>>(
          pending,
          opts?.signal,
        );
      }

      const controller = new AbortController();
      const entry: InflightEntry = {
        controller,
        waiters: 0,
        task: Promise.resolve(),
      };

      const task = (async () => {
        let cache: CacheStore | undefined;
        try {
          cache = store ?? defaultStore();
          const hit = await cache.get(key);
          if (hit != null) {
            logDebug("cache-hit", { requestId: opts?.requestId, namespace });
            const decoded = decodeStoredJson<Awaited<ReturnType<typeof loader>>>(hit);
            return decoded ?? (hit as Awaited<ReturnType<typeof loader>>);
          }
        } catch (error) {
          logError("cache-get", error, { requestId: opts?.requestId, namespace });
        }
        if (controller.signal.aborted) {
          throw createAbortError();
        }
        logDebug("cache-miss", { requestId: opts?.requestId, namespace });
        const value = await loader(controller.signal);
        if (cache && !controller.signal.aborted) {
          try {
            await cache.set(key, JSON.stringify(value), ttlSeconds);
          } catch (error) {
            logError("cache-set", error, { requestId: opts?.requestId, namespace });
          }
        }
        return value;
      })();

      entry.task = task as Promise<unknown>;
      inflight.set(key, entry);
      const cleanup = (err?: unknown) => {
        if (inflight.get(key) === entry) inflight.delete(key);
        // Swallow unhandled rejection noise when all waiters aborted.
        if (err && (isAbortError(err) || controller.signal.aborted)) return;
      };
      task.then(() => cleanup(), (err) => cleanup(err));
      return attachWaiter(entry, opts?.signal);
    },
  };
}

export const requestCache = createRequestCache();
