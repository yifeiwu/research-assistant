import "server-only";
import { serverConfig } from "@/lib/config";
import { abortableSleep, createAbortError, isAbortError } from "@/lib/errors";
import { logError, logInfo } from "@/lib/logger";
import { redis } from "@/lib/redis";

const SEQ_KEY = "queue:turns:seq";
const WAITING_KEY = "queue:turns:waiting";
const LEASE_KEY = "queue:turns:lease";

export type QueueDb = {
  incr: (key: string) => Promise<number>;
  zadd: (
    key: string,
    ...args:
      | [{ score: number; member: string }]
      | [{ nx: true }, { score: number; member: string }]
  ) => Promise<number | null>;
  zrank: (key: string, member: string) => Promise<number | null>;
  zrange: (
    key: string,
    min: number,
    max: number,
    opts: { byScore: true },
  ) => Promise<string[]>;
  zrem: (key: string, ...members: string[]) => Promise<number>;
  zcard: (key: string) => Promise<number>;
};

export class QueueBusyError extends Error {
  constructor() {
    super(
      "The server is busy with other requests right now, and this request waited too long in the queue. Please try again in a moment.",
    );
    this.name = "QueueBusyError";
  }
}

export type RequestQueue = {
  enabled: boolean;
  isFull(): Promise<boolean>;
  acquire(
    runId: string,
    opts?: {
      signal?: AbortSignal;
      deadlineAt?: number;
      onPosition?: (position: number | null) => void | Promise<void>;
    },
  ): Promise<() => Promise<void>>;
};

export function createRequestQueue(opts?: {
  db?: QueueDb | null;
  maxConcurrentTurns?: number;
  maxQueueLength?: number;
  maxWaitMs?: number;
  pollMs?: number;
  leaseMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}): RequestQueue {
  const maxConcurrent =
    opts?.maxConcurrentTurns ?? serverConfig.queue.maxConcurrentTurns;
  const maxQueueLength =
    opts?.maxQueueLength ?? serverConfig.queue.maxQueueLength;
  const maxWaitMs = opts?.maxWaitMs ?? serverConfig.queue.maxWaitMs;
  const pollMs = opts?.pollMs ?? serverConfig.queue.pollMs;
  const leaseMs = opts?.leaseMs ?? serverConfig.queue.leaseMs;
  const nowFn = opts?.now ?? Date.now;
  const enabled = maxConcurrent > 0;

  const resolveDb = (): QueueDb | undefined => {
    if (opts?.db === null) return undefined;
    if (opts?.db) return opts.db;
    try {
      return redis() as unknown as QueueDb;
    } catch {
      return undefined;
    }
  };

  const evictExpired = async (db: QueueDb, now: number) => {
    const expired = await db.zrange(LEASE_KEY, 0, now, { byScore: true });
    if (expired.length > 0) {
      await Promise.all([
        db.zrem(WAITING_KEY, ...expired),
        db.zrem(LEASE_KEY, ...expired),
      ]);
    }
  };

  const leave = async (db: QueueDb, runId: string) => {
    try {
      await Promise.all([
        db.zrem(WAITING_KEY, runId),
        db.zrem(LEASE_KEY, runId),
      ]);
    } catch (error) {
      logError("queue-leave", error, { runId });
    }
  };

  return {
    enabled,
    async isFull() {
      if (!enabled) return false;
      const db = resolveDb();
      if (!db) return false;
      try {
        await evictExpired(db, nowFn());
        const total = await db.zcard(WAITING_KEY);
        return total >= maxConcurrent + maxQueueLength;
      } catch (error) {
        logError("queue-check-full", error);
        return false;
      }
    },
    async acquire(runId, acquireOpts) {
      if (!enabled) return async () => {};
      const signal = acquireOpts?.signal;
      if (signal?.aborted) throw createAbortError();

      const db = resolveDb();
      if (!db) return async () => {};

      const startedAt = nowFn();
      const latestWait = Math.min(
        startedAt + maxWaitMs,
        acquireOpts?.deadlineAt ?? Number.POSITIVE_INFINITY,
      );
      let announced = false;

      const clearPosition = async () => {
        if (!announced) return;
        announced = false;
        try {
          await acquireOpts?.onPosition?.(null);
        } catch {
          // ignore
        }
      };

      try {
        await evictExpired(db, startedAt);
        const seq = await db.incr(SEQ_KEY);
        await Promise.all([
          db.zadd(WAITING_KEY, { nx: true }, { score: seq, member: runId }),
          db.zadd(LEASE_KEY, { score: startedAt + leaseMs, member: runId }),
        ]);

        for (;;) {
          if (signal?.aborted) {
            await leave(db, runId);
            throw createAbortError();
          }

          const now = nowFn();
          await evictExpired(db, now);
          await db.zadd(LEASE_KEY, { score: now + leaseMs, member: runId });

          let rank = await db.zrank(WAITING_KEY, runId);
          if (rank == null) {
            const nextSeq = await db.incr(SEQ_KEY);
            await db.zadd(WAITING_KEY, { nx: true }, { score: nextSeq, member: runId });
            rank = await db.zrank(WAITING_KEY, runId);
          }

          if (rank != null && rank < maxConcurrent) {
            await clearPosition();
            const waitedMs = nowFn() - startedAt;
            if (waitedMs > 0) {
              logInfo("queue-admitted", { runId, waitedMs });
            }

            const renewTimer = setInterval(() => {
              void db
                .zadd(LEASE_KEY, { score: nowFn() + leaseMs, member: runId })
                .catch((err) => logError("queue-renew", err, { runId }));
            }, Math.max(1_000, Math.floor(leaseMs / 3)));
            (renewTimer as { unref?: () => void }).unref?.();

            let released = false;
            return async () => {
              if (released) return;
              released = true;
              clearInterval(renewTimer);
              await leave(db, runId);
            };
          }

          if (now >= latestWait) {
            await leave(db, runId);
            throw new QueueBusyError();
          }

          const position = Math.max(1, (rank ?? maxConcurrent) - maxConcurrent + 1);
          announced = true;
          try {
            await acquireOpts?.onPosition?.(position);
          } catch {
            // ignore
          }

          await abortableSleep(pollMs, signal, opts?.sleep);
        }
      } catch (error) {
        await clearPosition();
        if (isAbortError(error) || signal?.aborted) {
          await leave(db, runId);
          throw createAbortError();
        }
        if (error instanceof QueueBusyError) {
          throw error;
        }
        // Fail open if Redis errors mid-poll so turns still execute.
        logError("queue-acquire", error, { runId });
        return async () => {};
      }
    },
  };
}

let sharedQueue: RequestQueue | undefined;

export function sharedRequestQueue(): RequestQueue {
  sharedQueue ??= createRequestQueue();
  return sharedQueue;
}
