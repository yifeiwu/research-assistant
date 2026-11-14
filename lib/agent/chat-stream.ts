import "server-only";
import { UI_MESSAGE_STREAM_HEADERS } from "ai";
import { redis } from "@/lib/redis";
import { logError, logInfo } from "@/lib/logger";

/**
 * Distributed SSE stream buffer and cancellation coordinator backed by Upstash
 * Redis.
 *
 * Allows `POST /api/chat` on one serverless isolate to keep streaming into
 * Redis after the client disconnects (tab switch, reload, thread switch), while
 * `GET /api/chat/:id/stream` and `POST /api/chat/:id/stop` on any isolate can
 * replay/tail chunks or signal cancellation.
 *
 * Each generation gets a unique `runId` so a superseding turn on the same
 * `chatId` never collides with or appends stray bytes to the newer run:
 *   - `chat:active:{chatId}` (String, TTL 600s) -> latest `runId`
 *   - `chat:run:{runId}:meta` (Hash, TTL 600s)  -> { status, stopped, updatedAt }
 *   - `chat:run:{runId}:chunks` (List, TTL 600s) -> coalesced SSE string batches
 */

const STREAM_TTL_SECONDS = 10 * 60;
const FLUSH_INTERVAL_MS = 150;
const FLUSH_CHAR_THRESHOLD = 16_384;
const HEARTBEAT_INTERVAL_MS = 1_000;
const POLL_FAST_MS = 200;
const POLL_IDLE_MS = 400;
const STALE_STREAM_MS = 45_000;

const encoder = new TextEncoder();

type RunMeta = {
  status?: "streaming" | "done";
  stopped?: string | number;
  updatedAt?: string | number;
};

export type ChatStreamHandle = {
  chatId: string;
  runId: string;
  abortController: AbortController;
  abortSignal: AbortSignal;
};

function activeKey(chatId: string): string {
  return `chat:active:${chatId}`;
}

function metaKey(runId: string): string {
  return `chat:run:${runId}:meta`;
}

function chunksKey(runId: string): string {
  return `chat:run:${runId}:chunks`;
}

export function isChatId(value: string): boolean {
  return /^[\w-]{8,80}$/.test(value);
}

function createSerialRunner(): <T>(fn: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(fn: () => Promise<T>): Promise<T> => {
    const run = tail.then(fn, fn);
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Register a new generation run for `chatId` in Redis, marking any previous
 * active run on the same thread as stopped so its isolate aborts promptly.
 * Returns an `AbortSignal` detached from the HTTP request so client disconnects
 * do not cancel generation.
 */
export async function startChatStream(
  chatId: string,
): Promise<ChatStreamHandle> {
  const db = redis();
  const runId = `r_${crypto.randomUUID()}`;
  const abortController = new AbortController();
  const now = String(Date.now());

  const prevRunId = await db.get<string>(activeKey(chatId));

  const pipe = db.pipeline();
  if (prevRunId) {
    pipe.hset(metaKey(prevRunId), { stopped: "1", updatedAt: now });
    pipe.expire(metaKey(prevRunId), STREAM_TTL_SECONDS);
  }
  pipe.hset(metaKey(runId), {
    status: "streaming",
    stopped: "0",
    updatedAt: now,
  });
  pipe.expire(metaKey(runId), STREAM_TTL_SECONDS);
  pipe.set(activeKey(chatId), runId, { ex: STREAM_TTL_SECONDS });
  await pipe.exec();

  logInfo("stream-start", { chatId, runId, superseded: Boolean(prevRunId) });

  return {
    chatId,
    runId,
    abortController,
    abortSignal: abortController.signal,
  };
}

/** Explicit Stop — signals the active run on any isolate to abort. */
export async function stopChatStream(chatId: string): Promise<boolean> {
  const db = redis();
  const runId = await db.get<string>(activeKey(chatId));
  if (!runId) return false;

  await db
    .pipeline()
    .hset(metaKey(runId), { stopped: "1", updatedAt: String(Date.now()) })
    .expire(metaKey(runId), STREAM_TTL_SECONDS)
    .exec();

  logInfo("stream-stop", { chatId, runId });
  return true;
}

/**
 * Consume a teed SSE string stream, batching writes to Redis every ~150ms (or
 * 16 KB) while polling for remote stop / supersede signals at least once per
 * second even during quiet tool calls.
 */
export async function ingestSseStream(
  handle: ChatStreamHandle,
  stream: ReadableStream<string>,
): Promise<void> {
  const { chatId, runId, abortController } = handle;
  const db = redis();
  const runSerial = createSerialRunner();

  let pending = "";
  let flushedBatches = 0;
  let lastSyncAt = Date.now();
  let finished = false;
  let flushTimer: ReturnType<typeof setTimeout> | undefined;

  async function syncToRedis(finalize: boolean): Promise<void> {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = undefined;
    }

    const batch = pending;
    pending = "";
    const now = String(Date.now());

    if (finalize) {
      const pipe = db.pipeline();
      if (batch.length > 0) {
        pipe.rpush(chunksKey(runId), batch);
        pipe.expire(chunksKey(runId), STREAM_TTL_SECONDS);
        flushedBatches += 1;
      }
      // Always RPUSH final bytes BEFORE marking status="done" in the pipeline
      // so readers polling HGETALL before LRANGE never miss trailing frames.
      pipe.hset(metaKey(runId), { status: "done", updatedAt: now });
      pipe.expire(metaKey(runId), STREAM_TTL_SECONDS);
      pipe.expire(activeKey(chatId), STREAM_TTL_SECONDS);
      await pipe.exec();
      lastSyncAt = Date.now();
      return;
    }

    const pipe = db.pipeline();
    if (batch.length > 0) {
      pipe.rpush(chunksKey(runId), batch);
      pipe.expire(chunksKey(runId), STREAM_TTL_SECONDS);
      flushedBatches += 1;
    }
    pipe.hset(metaKey(runId), { updatedAt: now });
    pipe.expire(metaKey(runId), STREAM_TTL_SECONDS);
    pipe.expire(activeKey(chatId), STREAM_TTL_SECONDS);
    pipe.hget<string | number>(metaKey(runId), "stopped");
    pipe.get<string>(activeKey(chatId));

    const results = await pipe.exec();
    lastSyncAt = Date.now();

    const stoppedVal = results[results.length - 2];
    const currentActive = results[results.length - 1] as string | null;
    const isStopped = String(stoppedVal) === "1";
    const isSuperseded = Boolean(currentActive && currentActive !== runId);

    if ((isStopped || isSuperseded) && !abortController.signal.aborted) {
      abortController.abort();
      logInfo("stream-abort-remote", {
        chatId,
        runId,
        stopped: isStopped,
        superseded: isSuperseded,
      });
    }
  }

  function scheduleSync(): void {
    if (finished) return;
    void runSerial(async () => {
      if (finished) return;
      try {
        await syncToRedis(false);
      } catch (error) {
        logError("stream-sync", error, { chatId, runId });
      }
    });
  }

  const heartbeatTimer = setInterval(() => {
    if (!finished && Date.now() - lastSyncAt >= HEARTBEAT_INTERVAL_MS) {
      scheduleSync();
    }
  }, HEARTBEAT_INTERVAL_MS);

  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      pending += value;

      if (pending.length >= FLUSH_CHAR_THRESHOLD) {
        await runSerial(async () => {
          try {
            await syncToRedis(false);
          } catch (error) {
            logError("stream-flush", error, { chatId, runId });
          }
        });
      } else if (!flushTimer) {
        flushTimer = setTimeout(() => {
          flushTimer = undefined;
          scheduleSync();
        }, FLUSH_INTERVAL_MS);
      }
    }
  } catch {
    // Source stream errored or aborted; finalize in `finally`.
  } finally {
    finished = true;
    clearInterval(heartbeatTimer);
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = undefined;
    }
    reader.releaseLock();

    try {
      await runSerial(() => syncToRedis(true));
    } catch (error) {
      logError("stream-finalize", error, { chatId, runId });
    }

    logInfo("stream-ingest-done", {
      chatId,
      runId,
      batches: flushedBatches,
      aborted: abortController.signal.aborted,
    });
  }
}

/**
 * Replay buffered SSE batches for `chatId` and, while the run is still active,
 * tail new batches from Redis until completion, client disconnect, or staleness.
 * Returns `null` when there is nothing to resume (caller responds 204).
 */
export async function resumeChatStream(
  chatId: string,
  signal?: AbortSignal,
): Promise<Response | null> {
  const db = redis();
  const runId = await db.get<string>(activeKey(chatId));
  if (!runId) return null;

  const [initialMeta, initialChunks] = await db
    .pipeline()
    .hgetall<RunMeta>(metaKey(runId))
    .lrange<string>(chunksKey(runId), 0, -1)
    .exec();

  if (!initialMeta?.status) return null;

  const initialDone = initialMeta.status === "done";
  const initialStopped = String(initialMeta.stopped) === "1";
  const initialUpdatedAt = Number(initialMeta.updatedAt) || 0;
  const initialStale =
    !initialDone &&
    initialUpdatedAt > 0 &&
    Date.now() - initialUpdatedAt > STALE_STREAM_MS;

  if (
    (initialDone || initialStopped || initialStale) &&
    initialChunks.length === 0
  ) {
    return null;
  }

  let cancelled = false;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const enqueueChunks = (batches: string[]) => {
        for (const batch of batches) {
          if (typeof batch === "string" && batch.length > 0) {
            controller.enqueue(encoder.encode(batch));
          }
        }
      };

      const safeClose = () => {
        try {
          controller.close();
        } catch {
          // Already closed or cancelled.
        }
      };

      try {
        enqueueChunks(initialChunks);
        let cursor = initialChunks.length;

        if (initialDone || initialStale) {
          safeClose();
          return;
        }

        let emptyPolls = 0;
        while (!cancelled && !signal?.aborted) {
          const delay = emptyPolls >= 5 ? POLL_IDLE_MS : POLL_FAST_MS;
          await sleep(delay, signal);
          if (cancelled || signal?.aborted) break;

          // Query HGETALL *before* LRANGE in the pipeline so observing
          // status="done" guarantees all preceding RPUSH batches are included.
          const [meta, nextChunks] = await db
            .pipeline()
            .hgetall<RunMeta>(metaKey(runId))
            .lrange<string>(chunksKey(runId), cursor, -1)
            .exec();

          if (cancelled || signal?.aborted) break;

          if (nextChunks.length > 0) {
            enqueueChunks(nextChunks);
            cursor += nextChunks.length;
            emptyPolls = 0;
          } else {
            emptyPolls += 1;
          }

          if (!meta?.status || meta.status === "done") {
            break;
          }

          const updatedAt = Number(meta.updatedAt) || 0;
          if (updatedAt > 0 && Date.now() - updatedAt > STALE_STREAM_MS) {
            logInfo("stream-resume-stale", { chatId, runId });
            break;
          }
        }
      } catch (error) {
        logError("stream-resume", error, { chatId, runId });
      } finally {
        safeClose();
      }
    },
    cancel() {
      cancelled = true;
    },
  });

  return new Response(stream, { headers: UI_MESSAGE_STREAM_HEADERS });
}
