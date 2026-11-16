import "server-only";
import { UI_MESSAGE_STREAM_HEADERS } from "ai";
import { sleepUntilAborted } from "@/lib/errors";
import { redis } from "@/lib/redis";
import { logError, logInfo } from "@/lib/logger";
import { CHAT_ID_REGEX } from "@/lib/types/chat";

/**
 * Distributed SSE stream buffer and cancellation coordinator backed by Upstash
 * Redis.
 *
 * A turn is streamed into Redis (lib/agent/detached.ts), so it carries on
 * after the client disconnects (tab switch, reload, thread switch), while
 * `POST /api/chat`, `GET /api/chat/:id/stream` and
 * `POST /api/chat/:id/stop` on any isolate can replay/tail chunks, poll
 * background completion, or signal cancellation.
 *
 * Each generation gets a unique `runId` so a superseding turn on the same
 * `chatId` never collides with or appends stray bytes to the newer run:
 *   - `chat:active:{chatId}` (String, TTL 600s) -> latest `runId`
 *   - `chat:run:{runId}:meta` (Hash, TTL 600s)  -> { status, stopped, updatedAt }
 *   - `chat:run:{runId}:chunks` (List, TTL 600s) -> coalesced SSE string batches
 *   - `chat:stop-turn:{chatId}:{turnId}` (String, TTL 120s) -> pre-start stop marker
 *
 * A run can span several attempts. Between attempts its status is `waiting`,
 * and `chat:run:{runId}:lease` (String, short TTL) names the invocation
 * driving it.
 */

const STREAM_TTL_SECONDS = 10 * 60;
const STOP_TURN_TTL_SECONDS = 2 * 60;
const FLUSH_INTERVAL_MS = 150;
const FLUSH_CHAR_THRESHOLD = 16_384;
const HEARTBEAT_INTERVAL_MS = 1_000;
const POLL_FAST_MS = 200;
const STALE_STREAM_MS = 45_000;

/**
 * The AI SDK's wire format for a UI message stream: one `data:` frame per
 * chunk, then a closing frame.
 */
const sseFrame = (chunk: unknown) => `data: ${JSON.stringify(chunk)}\n\n`;
const DONE_FRAME = "data: [DONE]\n\n";

const encoder = new TextEncoder();

type RunMeta = {
  /** `waiting`: no attempt is running, and the next is due at `wakeAt`. */
  status?: "streaming" | "waiting" | "done";
  stopped?: string | number;
  updatedAt?: string | number;
  turnId?: string;
  wakeAt?: string | number;
  /** "1" once answer text or reasoning has been buffered. */
  answerStarted?: string | number;
  /** Attempts made so far. */
  attempts?: string | number;
  /** Times an invocation handed the run over to a later request. */
  handOvers?: string | number;
  /** Times a later request's invocation took the run on. */
  continuations?: string | number;
  /** Time the run spent with no invocation driving it, past when it was due (ms). */
  parkedMs?: string | number;
};

/**
 * True when an unfinished run has shown no sign of life for too long: its
 * producer died, or its next attempt never came.
 */
function isStaleRun(meta: RunMeta, now: number): boolean {
  if (meta.status === "done") return false;
  const lastSeen = Math.max(Number(meta.updatedAt) || 0, Number(meta.wakeAt) || 0);
  return lastSeen > 0 && now - lastSeen > STALE_STREAM_MS;
}

/** A run being streamed by an attempt, and the switch that stops its work. */
export type ChatRun = {
  chatId: string;
  runId: string;
  /** Aborted by the ingester when the run is stopped or replaced. */
  abortController: AbortController;
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

function stopTurnKey(chatId: string, turnId: string): string {
  return `chat:stop-turn:${chatId}:${turnId}`;
}

export function isChatId(value: string): boolean {
  return CHAT_ID_REGEX.test(value);
}

export function isTurnId(value: unknown): value is string {
  return typeof value === "string" && /^[\w-]{1,120}$/.test(value);
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

type ChatRedis = ReturnType<typeof redis>;

/** Bounded exponential backoff with jitter for resume tail polling. */
function resumePollDelayMs(emptyPolls: number): number {
  const exponent = Math.min(Math.max(emptyPolls, 0), 3);
  const base = Math.min(1_000, POLL_FAST_MS * 2 ** exponent);
  return Math.round(base * (0.8 + Math.random() * 0.4));
}

/**
 * Register a new generation run for `chatId` in Redis, marking any previous
 * active run on the same thread as stopped so the attempt streaming it aborts
 * promptly. `preStopped` reports that an explicit Stop for `turnId` got here
 * before the turn did: the run is registered as already over.
 */
export async function startChatStream(
  chatId: string,
  turnId?: string,
  db: ChatRedis = redis(),
): Promise<{ runId: string; preStopped: boolean }> {
  const runId = `r_${crypto.randomUUID()}`;
  const now = String(Date.now());
  const validTurnId = isTurnId(turnId) ? turnId : undefined;

  const lookupPipe = db.pipeline();
  lookupPipe.get<string>(activeKey(chatId));
  if (validTurnId) {
    lookupPipe.get<string>(stopTurnKey(chatId, validTurnId));
  }
  const lookupResults = await lookupPipe.exec();

  const prevRunId = lookupResults[0] as string | null;
  // Stop was pressed for this turn before the request for it got here.
  const preStopped = validTurnId
    ? String(lookupResults[1] ?? "") === "1"
    : false;

  const pipe = db.pipeline();
  if (prevRunId) {
    pipe.hset(metaKey(prevRunId), { stopped: "1", updatedAt: now });
    pipe.expire(metaKey(prevRunId), STREAM_TTL_SECONDS);
  }
  pipe.hset(metaKey(runId), {
    status: preStopped ? "done" : "streaming",
    stopped: preStopped ? "1" : "0",
    updatedAt: now,
    // Bind the run to its turn so a delayed Stop for an older turn cannot
    // abort a newer turn that has since superseded it on this chat.
    turnId: validTurnId ?? "",
  });
  pipe.expire(metaKey(runId), STREAM_TTL_SECONDS);
  pipe.set(activeKey(chatId), runId, { ex: STREAM_TTL_SECONDS });
  await pipe.exec();

  logInfo("stream-start", {
    chatId,
    runId,
    superseded: Boolean(prevRunId),
    preStopped,
  });

  return { runId, preStopped };
}

/** The run currently registered for a chat, if any. */
export async function activeChatRun(
  chatId: string,
  db: ChatRedis = redis(),
): Promise<string | null> {
  return db.get<string>(activeKey(chatId));
}

/**
 * Cleanly finalize a run that could not be started, so it never lingers as
 * a stale `"streaming"` entry with 0 chunks.
 */
export async function abortChatStream(
  chatId: string,
  runId: string,
  db: ChatRedis = redis(),
): Promise<void> {
  try {
    const now = String(Date.now());
    await db
      .pipeline()
      .hset(metaKey(runId), {
        status: "done",
        stopped: "1",
        updatedAt: now,
      })
      .expire(metaKey(runId), STREAM_TTL_SECONDS)
      .exec();
  } catch (error) {
    logError("stream-abort-cleanup", error, { chatId, runId });
  }
}

/**
 * Explicit Stop — signals the attempt streaming the active run to abort, and
 * records a short-lived turn tombstone in case `POST /api/chat` has not
 * called `startChatStream` yet.
 */
export async function stopChatStream(
  chatId: string,
  turnId?: string,
  db: ChatRedis = redis(),
): Promise<boolean> {
  const runId = await db.get<string>(activeKey(chatId));
  const validTurnId = isTurnId(turnId) ? turnId : undefined;

  // Only stop the active run when it belongs to the requested turn. A Stop
  // POST can arrive late (retried/slow network) after the user has already
  // sent a new turn on the same chat; stopping the active run unconditionally
  // would kill that newer generation. Runs started without a turn id (legacy
  // callers) have an empty stored turnId and are still stoppable.
  let stopActive = Boolean(runId);
  if (runId && validTurnId) {
    const storedTurnId = await db.hget<string>(metaKey(runId), "turnId");
    if (storedTurnId && storedTurnId !== validTurnId) stopActive = false;
  }

  // A waiting run has no attempt running to notice the stop flag, so end
  // it here; anyone tailing it is released straight away.
  if (runId && stopActive) {
    const status = await db.hget<string>(metaKey(runId), "status");
    if (status === "waiting") {
      await endChatRun(chatId, runId, { type: "abort" }, db);
    }
  }

  const pipe = db.pipeline();
  if (runId && stopActive) {
    pipe.hset(metaKey(runId), { stopped: "1", updatedAt: String(Date.now()) });
    pipe.expire(metaKey(runId), STREAM_TTL_SECONDS);
  }
  if (validTurnId) {
    pipe.set(stopTurnKey(chatId, validTurnId), "1", {
      ex: STOP_TURN_TTL_SECONDS,
    });
  }
  await pipe.exec();

  logInfo("stream-stop", { chatId, runId, turnId: validTurnId, stopActive });
  return Boolean((runId && stopActive) || validTurnId);
}

/**
 * End a run with a final frame when no attempt is streaming it: a stop while
 * it was waiting, or an attempt that cannot go ahead.
 */
export async function endChatRun(
  chatId: string,
  runId: string,
  end: { type: "abort" } | { type: "error"; errorText: string },
  db: ChatRedis = redis(),
): Promise<void> {
  const now = String(Date.now());
  await db
    .pipeline()
    .rpush(chunksKey(runId), sseFrame(end) + DONE_FRAME)
    .expire(chunksKey(runId), STREAM_TTL_SECONDS)
    // Chunks are pushed before the status flips, as in `ingestChunkStream`.
    .hset(metaKey(runId), {
      status: "done",
      updatedAt: now,
      ...(end.type === "abort" ? { stopped: "1" } : {}),
    })
    .expire(metaKey(runId), STREAM_TTL_SECONDS)
    .exec();
  logInfo("stream-end", { chatId, runId, end: end.type });
}

/** What an attempt needs to know before continuing a run. */
export type ChatRunState = {
  status: "streaming" | "waiting" | "done";
  /** Stopped by the user, or replaced by a newer turn on the same chat. */
  cancelled: boolean;
  answerStarted: boolean;
  attempts: number;
  /** Batches already buffered; 0 means the message has not been opened. */
  chunkCount: number;
  /** When a `waiting` run's next attempt is due; 0 if none was scheduled. */
  wakeAt: number;
  /** When the run last showed a sign of life. */
  updatedAt: number;
  /** How the run has been passed between invocations; see `RunMeta`. */
  handOvers: number;
  continuations: number;
  parkedMs: number;
};

export async function readChatRunState(
  chatId: string,
  runId: string,
  db: ChatRedis = redis(),
): Promise<ChatRunState | null> {
  const [meta, active, chunkCount] = (await db
    .pipeline()
    .hgetall<RunMeta>(metaKey(runId))
    .get<string>(activeKey(chatId))
    .llen(chunksKey(runId))
    .exec()) as [RunMeta | null, string | null, number];
  if (!meta?.status) return null;
  return {
    status: meta.status,
    cancelled: String(meta.stopped) === "1" || Boolean(active && active !== runId),
    answerStarted: String(meta.answerStarted) === "1",
    attempts: Number(meta.attempts) || 0,
    chunkCount: Number(chunkCount) || 0,
    wakeAt: Number(meta.wakeAt) || 0,
    updatedAt: Number(meta.updatedAt) || 0,
    handOvers: Number(meta.handOvers) || 0,
    continuations: Number(meta.continuations) || 0,
    parkedMs: Number(meta.parkedMs) || 0,
  };
}

/**
 * Mark a run as being streamed again and count the attempt. `continued` is
 * given by an invocation taking the run on from another, with how long the
 * run had been left waiting for it.
 */
export async function beginChatRunAttempt(
  runId: string,
  db: ChatRedis = redis(),
  continued?: { parkedMs: number },
): Promise<void> {
  const pipe = db.pipeline();
  pipe.hincrby(metaKey(runId), "attempts", 1);
  if (continued) {
    pipe.hincrby(metaKey(runId), "continuations", 1);
    pipe.hincrby(metaKey(runId), "parkedMs", Math.max(0, Math.round(continued.parkedMs)));
  }
  pipe.hset(metaKey(runId), { status: "streaming", updatedAt: String(Date.now()) });
  pipe.expire(metaKey(runId), STREAM_TTL_SECONDS);
  await pipe.exec();
}

/** Count an invocation handing the run over. Only feeds the turn's summary. */
export async function countChatRunHandOver(
  runId: string,
  db: ChatRedis = redis(),
): Promise<void> {
  await db
    .pipeline()
    .hincrby(metaKey(runId), "handOvers", 1)
    // So that counting on a run that has since expired leaves nothing behind.
    .expire(metaKey(runId), STREAM_TTL_SECONDS)
    .exec();
}

/** Give back an attempt that did no work (it only waited in the queue). */
export async function refundChatRunAttempt(
  runId: string,
  db: ChatRedis = redis(),
): Promise<void> {
  await db.hincrby(metaKey(runId), "attempts", -1);
}

/**
 * Leave an unfinished run for a later attempt, due at `wakeAt`, when no
 * attempt's stream is open to record that (see `AttemptIngest.wakeAt`).
 */
export async function parkChatRun(
  runId: string,
  wakeAt: number,
  db: ChatRedis = redis(),
): Promise<void> {
  await db
    .pipeline()
    .hset(metaKey(runId), {
      status: "waiting",
      wakeAt: String(wakeAt),
      updatedAt: String(Date.now()),
    })
    .expire(metaKey(runId), STREAM_TTL_SECONDS)
    .exec();
}

export function runLeaseKey(runId: string): string {
  return `chat:run:${runId}:lease`;
}

/**
 * One run may be streamed by several attempts in turn (see
 * lib/agent/detached.ts), so the end of one attempt's stream is not
 * necessarily the end of the run.
 */
export type AttemptIngest = {
  /**
   * Lease of the invocation driving the run. Kept alive while the attempt
   * streams; releasing it is up to its holder.
   */
  lease: { key: string; token: string; ttlSeconds: number };
  /**
   * Settles once the attempt's stream has closed. A time parks the run (no
   * closing frame is written) for a later attempt to continue then;
   * `undefined` means the run is over.
   */
  wakeAt: Promise<number | undefined>;
};

/**
 * Consume one attempt's UI message chunks into the run's SSE buffer.
 *
 * Two things go to Redis, on separate clocks:
 * - What the attempt streams, batched every ~150ms (or 16 KB). A flush
 *   writes the batch and nothing else, since it is the hot path while an
 *   answer streams.
 * - A heartbeat once a second, however much or little is streaming. It
 *   keeps the run alive (its `updatedAt`, its keys' TTLs and the driving
 *   invocation's lease) and reads whether the run was stopped, replaced or
 *   ended elsewhere, in which case the attempt's work is aborted.
 */
export async function ingestChunkStream(
  run: ChatRun,
  stream: ReadableStream<{ type: string }>,
  attempt: AttemptIngest,
  db: ChatRedis = redis(),
): Promise<void> {
  const { chatId, runId, abortController } = run;
  const runSerial = createSerialRunner();

  let pending = "";
  let flushedBatches = 0;
  let finished = false;
  // Set once the run is closed, by this attempt or from elsewhere. Nothing
  // more is written to it after that.
  let finalized = false;
  let flushTimer: ReturnType<typeof setTimeout> | undefined;
  let heartbeatQueued = false;
  let answerStarted = false;
  let answerStartRecorded = false;

  const cancelFlushTimer = () => {
    if (!flushTimer) return;
    clearTimeout(flushTimer);
    flushTimer = undefined;
  };

  /**
   * Run a pipeline that writes `taken` (what was just removed from
   * `pending`). If it fails (a transient Redis error), `taken` goes back to
   * the front of `pending` so that the next write retries it, instead of
   * leaving a hole in the buffered stream that clients replay.
   */
  const execOrRestore = async (
    pipe: ReturnType<ChatRedis["pipeline"]>,
    taken: string,
    wrote: { batch: boolean; answerStart: boolean },
  ): Promise<void> => {
    try {
      await pipe.exec();
    } catch (error) {
      pending = taken + pending;
      throw error;
    }
    if (wrote.batch) flushedBatches += 1;
    if (wrote.answerStart) answerStartRecorded = true;
  };

  /** Write what the attempt has streamed since the last flush. */
  async function flush(): Promise<void> {
    cancelFlushTimer();
    if (finalized || pending.length === 0) return;
    const taken = pending;
    pending = "";
    const answerStart = answerStarted && !answerStartRecorded;

    const pipe = db.pipeline();
    // Goes with (and ahead of) the first of the answer's text, not at the
    // next heartbeat: were the invocation to die in between, the answer
    // would be taken for unstarted and written a second time.
    if (answerStart) pipe.hset(metaKey(runId), { answerStarted: "1" });
    pipe.rpush(chunksKey(runId), taken);
    // The list may only come into being with this write, and must not be
    // left without a TTL if the invocation dies before its first heartbeat.
    if (flushedBatches === 0) pipe.expire(chunksKey(runId), STREAM_TTL_SECONDS);
    await execOrRestore(pipe, taken, { batch: true, answerStart });
  }

  /** Keep the run alive, and stop this attempt's work if the run is over. */
  async function heartbeat(): Promise<void> {
    if (finalized) return;
    const pipe = db.pipeline();
    pipe.hget<string>(metaKey(runId), "status");
    pipe.hget<string | number>(metaKey(runId), "stopped");
    pipe.get<string>(activeKey(chatId));
    pipe.hset(metaKey(runId), { updatedAt: String(Date.now()) });
    pipe.expire(metaKey(runId), STREAM_TTL_SECONDS);
    pipe.expire(chunksKey(runId), STREAM_TTL_SECONDS);
    pipe.expire(activeKey(chatId), STREAM_TTL_SECONDS);
    // The driving invocation's claim on the run.
    pipe.set(attempt.lease.key, attempt.lease.token, {
      ex: attempt.lease.ttlSeconds,
    });
    const [status, stoppedVal, currentActive] = (await pipe.exec()) as [
      string | null,
      string | number | null,
      string | null,
    ];

    // Closed by someone else: a stop that found the run waiting, or another
    // invocation that took it for dead. Nothing this attempt streams from
    // here on would be seen, so its work stops too.
    const endedElsewhere = status === "done";
    const isStopped = String(stoppedVal) === "1";
    const isSuperseded = Boolean(currentActive && currentActive !== runId);
    if (endedElsewhere) finalized = true;

    if (
      (endedElsewhere || isStopped || isSuperseded) &&
      !abortController.signal.aborted
    ) {
      abortController.abort();
      logInfo("stream-abort-remote", {
        chatId,
        runId,
        stopped: isStopped,
        superseded: isSuperseded,
        endedElsewhere,
      });
    }
  }

  /**
   * Close the attempt: write what is left and either end the run or park it
   * for a later attempt. Does nothing for a run that is already closed.
   */
  async function finalize(): Promise<void> {
    cancelFlushTimer();
    if (finalized) return;
    // The stream has closed by now, so this is already settled.
    const wakeAt = await attempt.wakeAt;

    const taken = pending;
    pending = "";
    // The closing frame goes out with the last batch, and only if the run is
    // over: a parked run's stream is continued by a later attempt.
    const batch = wakeAt === undefined ? taken + DONE_FRAME : taken;
    const now = String(Date.now());
    const answerStart = answerStarted && !answerStartRecorded;
    const metaExtras: Record<string, string> = answerStart
      ? { answerStarted: "1" }
      : {};

    const pipe = db.pipeline();
    if (batch.length > 0) {
      pipe.rpush(chunksKey(runId), batch);
      pipe.expire(chunksKey(runId), STREAM_TTL_SECONDS);
    }
    // Always RPUSH final bytes BEFORE marking status="done" in the pipeline
    // so readers polling HGETALL before LRANGE never miss trailing frames.
    pipe.hset(
      metaKey(runId),
      wakeAt !== undefined
        ? { status: "waiting", wakeAt: String(wakeAt), updatedAt: now, ...metaExtras }
        : { status: "done", updatedAt: now, ...metaExtras },
    );
    pipe.expire(metaKey(runId), STREAM_TTL_SECONDS);
    pipe.expire(activeKey(chatId), STREAM_TTL_SECONDS);
    await execOrRestore(pipe, taken, { batch: batch.length > 0, answerStart });
    finalized = true;
  }

  function scheduleFlush(): void {
    if (finished) return;
    void runSerial(async () => {
      if (finished) return;
      try {
        await flush();
      } catch (error) {
        logError("stream-flush", error, { chatId, runId });
      }
    });
  }

  const heartbeatTimer = setInterval(() => {
    // One at a time: a slow Redis must not build up a queue of them.
    if (finished || heartbeatQueued) return;
    heartbeatQueued = true;
    void runSerial(async () => {
      try {
        if (!finished) await heartbeat();
      } catch (error) {
        logError("stream-heartbeat", error, { chatId, runId });
      } finally {
        heartbeatQueued = false;
      }
    });
  }, HEARTBEAT_INTERVAL_MS);

  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value.type === "text-start" || value.type === "reasoning-start") {
        answerStarted = true;
      }
      pending += sseFrame(value);

      if (pending.length >= FLUSH_CHAR_THRESHOLD) {
        await runSerial(async () => {
          try {
            await flush();
          } catch (error) {
            logError("stream-flush", error, { chatId, runId });
          }
        });
      } else if (!flushTimer) {
        flushTimer = setTimeout(() => {
          flushTimer = undefined;
          scheduleFlush();
        }, FLUSH_INTERVAL_MS);
      }
    }
  } catch {
    // Source stream errored or aborted; finalize in `finally`.
  } finally {
    finished = true;
    clearInterval(heartbeatTimer);
    cancelFlushTimer();
    reader.releaseLock();

    try {
      await runSerial(finalize);
    } catch (error) {
      // The failed batch was restored to `pending`; retry finalize once so a
      // transient Redis blip doesn't leave the run stuck in "streaming".
      logError("stream-finalize", error, { chatId, runId });
      try {
        await runSerial(finalize);
      } catch (retryError) {
        logError("stream-finalize-retry", retryError, { chatId, runId });
      }
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
 * The batches up to the one that closes the stream. The closing frame is
 * always the end of the batch that carries it, and it ends the stream for
 * readers whatever follows: an attempt that has not yet noticed its run was
 * ended elsewhere may append to the buffer for up to a heartbeat.
 */
function untilClosed(batches: string[]): { batches: string[]; closed: boolean } {
  const end = batches.findIndex(
    (batch) => typeof batch === "string" && batch.endsWith(DONE_FRAME),
  );
  return end === -1
    ? { batches, closed: false }
    : { batches: batches.slice(0, end + 1), closed: true };
}

/**
 * Replay buffered SSE batches for `chatId` and, while the run is still active,
 * tail new batches from Redis until completion, client disconnect, or staleness.
 *
 * When `opts.onlyDone` is true (used by background thread collection), returns:
 *   - `202` immediately if the run is still actively streaming (0 chunk bytes read)
 *   - `null` (caller responds `204`) if nothing is stored or 0 chunks exist
 *   - `200` with the full buffered SSE stream once finished (or stale with chunks)
 */
export async function resumeChatStream(
  chatId: string,
  signal?: AbortSignal,
  opts?: {
    onlyDone?: boolean;
    /** Tail this run instead of whichever is active on the chat. */
    runId?: string;
    /** Called when a returned tail stops following the run, however it ends. */
    onClose?: () => void;
  },
  db: ChatRedis = redis(),
): Promise<Response | null> {
  const runId = opts?.runId ?? (await db.get<string>(activeKey(chatId)));
  if (!runId) return null;

  if (opts?.onlyDone) {
    const meta = await db.hgetall<RunMeta>(metaKey(runId));
    if (!meta?.status) return null;

    const done = meta.status === "done";
    const stale = isStaleRun(meta, Date.now());

    if (!done && !stale) {
      return new Response(null, { status: 202 });
    }

    const { batches: chunks } = untilClosed(
      await db.lrange<string>(chunksKey(runId), 0, -1),
    );
    if (chunks.length === 0) return null;

    const payload = chunks.join("");
    return new Response(encoder.encode(payload), {
      headers: {
        ...UI_MESSAGE_STREAM_HEADERS,
        // Let background collectors distinguish a complete answer from a
        // stale (producer died mid-stream) partial so they don't silently
        // persist a truncated answer as if it were final.
        ...(stale ? { "x-chat-stream-stale": "1" } : {}),
      },
    });
  }

  const [initialMeta, initialChunks] = await db
    .pipeline()
    .hgetall<RunMeta>(metaKey(runId))
    .lrange<string>(chunksKey(runId), 0, -1)
    .exec();

  if (!initialMeta?.status) return null;

  const initialDone = initialMeta.status === "done";
  const initialStopped = String(initialMeta.stopped) === "1";
  const initialStale = isStaleRun(initialMeta, Date.now());

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
        const initial = untilClosed(initialChunks);
        enqueueChunks(initial.batches);
        let cursor = initialChunks.length;

        if (initialDone || initialStale || initial.closed) {
          safeClose();
          return;
        }

        let emptyPolls = 0;
        while (!cancelled && !signal?.aborted) {
          await sleepUntilAborted(resumePollDelayMs(emptyPolls), signal);
          if (cancelled || signal?.aborted) break;

          // Query HGETALL *before* LRANGE in the pipeline so observing
          // status="done" guarantees all preceding RPUSH batches are included.
          const [meta, nextChunks, totalChunks] = await db
            .pipeline()
            .hgetall<RunMeta>(metaKey(runId))
            .lrange<string>(chunksKey(runId), cursor, -1)
            .llen(chunksKey(runId))
            .exec();

          if (cancelled || signal?.aborted) break;

          // Chunk list was evicted/trimmed under our cursor: the tail can no
          // longer be reconstructed faithfully, so stop rather than skip.
          if (typeof totalChunks === "number" && totalChunks < cursor) {
            logInfo("stream-resume-cursor-drift", { chatId, runId, cursor, totalChunks });
            break;
          }

          const next = untilClosed(nextChunks);
          if (nextChunks.length > 0) {
            enqueueChunks(next.batches);
            cursor += nextChunks.length;
            emptyPolls = 0;
          } else {
            emptyPolls += 1;
          }

          if (next.closed || !meta?.status || meta.status === "done") {
            break;
          }

          if (isStaleRun(meta, Date.now())) {
            logInfo("stream-resume-stale", { chatId, runId });
            break;
          }
        }
      } catch (error) {
        logError("stream-resume", error, { chatId, runId });
      } finally {
        safeClose();
        opts?.onClose?.();
      }
    },
    cancel() {
      cancelled = true;
      opts?.onClose?.();
    },
  });

  return new Response(stream, { headers: UI_MESSAGE_STREAM_HEADERS });
}
