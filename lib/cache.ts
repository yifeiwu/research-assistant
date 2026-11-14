import "server-only";
import { createHash } from "node:crypto";
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
    // Upstash's client auto-deserializes JSON on read: a stored JSON object
    // or array comes back as an object/array, and a stored JSON string comes
    // back as the plain string — not as raw JSON text.
    get: (key) => db.get(key),
    set: (key, value, ttlSeconds) => db.set(key, value, { ex: ttlSeconds }),
  };
}

export function cacheKey(namespace: string, parts: unknown): string {
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
    loader: () => Promise<T>,
    opts?: { bypass?: boolean; requestId?: string; signal?: AbortSignal },
  ): Promise<T>;
};

/**
 * Await a shared task, rejecting promptly if *this* caller's signal aborts
 * without cancelling the underlying shared work for other waiters.
 */
function withCallerAbort<T>(task: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return task;
  if (signal.aborted) {
    return Promise.reject(new DOMException("The operation was aborted.", "AbortError"));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () =>
      reject(new DOMException("The operation was aborted.", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
    task.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

/**
 * Fail-open Redis cache with in-process in-flight coalescing.
 *
 * Loaders must be signal-free: the same in-flight task may serve several
 * callers, so one caller's cancellation must not fail the others. Callers
 * pass their own `signal` via opts instead — it only detaches that caller
 * from the shared task (which keeps running and still populates the cache).
 */
export function createRequestCache(store?: CacheStore): RequestCache {
  const inflight = new Map<string, Promise<unknown>>();
  return {
    async wrap(namespace, parts, ttlSeconds, loader, opts) {
      if (opts?.bypass || ttlSeconds <= 0) return withCallerAbort(loader(), opts?.signal);
      const key = cacheKey(namespace, parts);
      const pending = inflight.get(key);
      if (pending) {
        return withCallerAbort(
          pending as Promise<Awaited<ReturnType<typeof loader>>>,
          opts?.signal,
        );
      }

      const task = (async () => {
        let cache: CacheStore | undefined;
        try {
          cache = store ?? defaultStore();
          const hit = await cache.get(key);
          if (hit != null) {
            logDebug("cache-hit", { requestId: opts?.requestId, namespace });
            // Already-deserialized values (objects/arrays/plain strings from
            // Upstash) are used as-is; only a raw JSON string needs parsing,
            // and a plain non-JSON string is the value itself.
            if (typeof hit !== "string") return hit as Awaited<ReturnType<typeof loader>>;
            try {
              return JSON.parse(hit) as Awaited<ReturnType<typeof loader>>;
            } catch {
              return hit as Awaited<ReturnType<typeof loader>>;
            }
          }
        } catch (error) {
          logError("cache-get", error, { requestId: opts?.requestId, namespace });
        }
        logDebug("cache-miss", { requestId: opts?.requestId, namespace });
        const value = await loader();
        if (cache) {
          try {
            await cache.set(key, JSON.stringify(value), ttlSeconds);
          } catch (error) {
            logError("cache-set", error, { requestId: opts?.requestId, namespace });
          }
        }
        return value;
      })();

      inflight.set(key, task as Promise<unknown>);
      // Clean up when the shared task itself settles — not when the first
      // caller returns, since an aborted first caller detaches early while
      // the task (and later waiters) are still in flight.
      const cleanup = () => {
        if (inflight.get(key) === task) inflight.delete(key);
      };
      task.then(cleanup, cleanup);
      return withCallerAbort(task, opts?.signal);
    },
  };
}

export const requestCache = createRequestCache();
