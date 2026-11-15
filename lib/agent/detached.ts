import "server-only";
import { convertToModelMessages, type UIMessage } from "ai";
import { serverConfig } from "@/lib/config";
import { effortConfig } from "@/lib/effort";
import { logError, logInfo } from "@/lib/logger";
import { redis } from "@/lib/redis";
import {
  sharedAdmissionQueue,
  type AdmissionQueue,
  type AdmissionTicket,
} from "./admission";
import {
  beginChatRunAttempt,
  countChatRunHandOver,
  endChatRun,
  ingestChunkStream,
  parkChatRun,
  readChatRunState,
  refundChatRunAttempt,
  resumeChatStream,
  runLeaseKey,
  type ChatRunState,
} from "./chat-stream";
import { isResolutionError } from "./models";
import { startTurn, type TurnCheckpoint, type TurnStats } from "./turn";

/**
 * A turn does not depend on the request that asked for it. It is saved as a
 * job in Redis and run in *attempts*, each streaming into the run's buffer
 * there, which any request can replay and tail (lib/agent/chat-stream.ts).
 *
 * Only a request can run code, so a run is *driven* (its attempts are run)
 * by a request that tails it, in work that outlives the response (`after()`
 * in the routes):
 *
 *   POST /api/chat              saves the job, drives the run and tails it.
 *   GET  /api/chat/:id/stream   tails it, and drives it if nobody else is.
 *
 * One invocation drives a run at a time; the run lease says which. An
 * attempt can end three ways:
 * - The turn finished.
 * - It deferred: the turn is still queued, or its answer has to wait for a
 *   rate-limit window. The driver waits, then runs another attempt.
 * - It threw. The driver retries it a few times, then ends the run with an
 *   error.
 *
 * An invocation only lives so long (300s), so one that is getting old
 * *hands the run over* rather than start something it may not finish. It
 * parks the run and ends its tail without a closing frame; that makes the
 * browser reconnect, and the request it sends takes the run on. A crash
 * comes to the same thing: the lease lapses, and the next request to tail
 * the run continues it from its research checkpoint.
 *
 * So a run that needs a second invocation waits for a request to arrive. If
 * nobody is looking (the tab is in the background), it stays parked until
 * they are; each such continuation is logged as `detached-continued`.
 *
 * Retries are only safe before the answer has started streaming (research is
 * idempotent: parts are replaced by id and sources de-duplicated by URL).
 * After that, a dead attempt ends the run with an error.
 */
export type ChatJob = {
  runId: string;
  chatId: string;
  /** Stable across attempts so re-emitted stream parts replace earlier ones. */
  requestId: string;
  model?: string;
  effort?: unknown;
  /** Conversation, already pruned for the model. */
  messages: UIMessage[];
  query: string;
  /** Place in the research queue; absent for turns that need no slot. */
  ticket?: AdmissionTicket;
  createdAt: number;
};

/** Minimal Redis surface the job store needs (injectable for tests). */
export type JobDb = {
  get: <T>(key: string) => Promise<T | null>;
  set: (
    key: string,
    value: string,
    opts?: { ex?: number; nx?: boolean },
  ) => Promise<unknown>;
  del: (...keys: string[]) => Promise<unknown>;
};

type ChatDb = NonNullable<Parameters<typeof ingestChunkStream>[3]>;
type Db = ChatDb & JobDb;

const defaultDb = () => redis() as unknown as Db;

const jobKey = (runId: string) => `chat:job:${runId}`;
const checkpointKey = (runId: string) => `chat:job:${runId}:checkpoint`;

/** Upstash decodes JSON values on read; other clients return the string. */
function decode<T>(raw: unknown): T | null {
  if (raw == null) return null;
  if (typeof raw !== "string") return raw as T;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/** Resolves after `ms`, or as soon as `signal` aborts. */
function sleepFor(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener("abort", finish, { once: true });
  });
}

/** Save a turn's job, for `tailDetachedTurn` to run. */
export async function saveDetachedTurn(job: ChatJob, db?: JobDb): Promise<void> {
  await (db ?? defaultDb()).set(jobKey(job.runId), JSON.stringify(job), {
    ex: serverConfig.detached.jobTtlSeconds,
  });
  logInfo("detached-saved", { requestId: job.requestId, runId: job.runId });
}

/** Withdraw a job that will not be run after all. */
export async function discardDetachedTurn(runId: string, db?: JobDb): Promise<void> {
  try {
    await (db ?? defaultDb()).del(jobKey(runId), checkpointKey(runId));
  } catch (error) {
    logError("detached-discard", error, { runId });
  }
}

/**
 * Drop a job that will not run again: its saved state and its place in the
 * research queue. Without the latter, a stopped or failed turn that was
 * still in line would block everyone behind it until its ticket expired.
 */
async function forgetJob(
  job: ChatJob,
  ctx: { db: JobDb; queue: AdmissionQueue },
): Promise<void> {
  if (job.ticket) await ctx.queue.cancel(job.ticket);
  await ctx.db.del(jobKey(job.runId), checkpointKey(job.runId));
}

/** The `serverConfig.detached` values driving a run uses. */
export type DriveConfig = {
  jobTtlSeconds: number;
  maxAttempts: number;
  queuePollDelayMs: number;
  runLeaseSeconds: number;
  retries: number;
  retryDelayMs: number;
  maxDeferMs: number;
  invocationLimitMs: number;
  finishMarginMs: number;
  handoffAfterMs: number;
  watchIntervalMs: number;
};

export type DriveDeps = {
  /** Redis client; also used for the stream buffer. */
  db?: Db;
  queue?: AdmissionQueue;
  startTurn?: typeof startTurn;
  config?: Partial<DriveConfig>;
  maxQueueWaitMs?: number;
  now?: () => number;
  /** Resolves after `ms`, or as soon as `signal` aborts. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
};

/**
 * The request an invocation is serving:
 * - `start`: the `POST /api/chat` that asked for the turn.
 * - `resume`: a later request tailing it.
 * - `poll`: a later request only asking whether it has finished.
 */
export type DriveOrigin = "start" | "resume" | "poll";

export type Invocation = {
  origin: DriveOrigin;
  /** When the request began; the invocation's time limit counts from here. */
  startedAt: number;
};

/**
 * - `done`: the run is over, or there was nothing to run.
 * - `busy`: another invocation is driving it.
 * - `handed-over`: it is unfinished, and this invocation can do no more for
 *   it. The next request to tail it continues.
 */
export type DriveResult = "done" | "busy" | "handed-over";

type DriveContext = {
  db: Db;
  queue: AdmissionQueue;
  config: DriveConfig;
  now: () => number;
  startTurn: typeof startTurn;
  maxQueueWaitMs: number;
  origin: DriveOrigin;
  lease: { key: string; token: string; ttlSeconds: number };
  /** Past this, the invocation starts nothing that takes long. */
  startBy: number;
  /** When the invocation's work has to be over, with time left to close the run. */
  finishBy: number;
  /** Attempts this invocation has begun. */
  begun: number;
  /** Called once the run is visibly in this invocation's hands. */
  onEngaged: () => void;
};

/**
 * - `over`: the run has ended (answered, failed or cancelled).
 * - `failed`: the attempt threw, and can be tried again.
 * - `handoff`: the run is unfinished, and not for this invocation to continue.
 * - `resumeInMs`: the run is unfinished, and its next attempt is due then.
 */
type AttemptOutcome = "over" | "failed" | "handoff" | { resumeInMs: number };

/**
 * How a turn ended:
 * - `answered`: with an answer.
 * - `failed`: with an error from its last attempt.
 * - `cancelled`: stopped by the user, or replaced by a newer turn.
 * - `interrupted`: its invocation died mid-answer.
 * - `exhausted`: out of attempts, or every retry of an attempt threw.
 * - `misconfigured`: the server could not build its models.
 */
type TurnOutcome =
  | "answered"
  | "failed"
  | "cancelled"
  | "interrupted"
  | "exhausted"
  | "misconfigured";

/**
 * The one log line that describes a whole turn, written when its run ends:
 * how it ended, where the time went, and how the run got there (attempts,
 * and how often it was passed between invocations). Durations are in ms.
 *
 * A turn that is never finished logs none: one parked for a request that
 * did not come has `detached-handed-over` as its last line.
 */
function logTurnSummary(
  job: ChatJob,
  outcome: TurnOutcome,
  input: {
    now: number;
    /** The run's counters as of the end, including the attempt just made. */
    run: Pick<ChatRunState, "attempts" | "handOvers" | "continuations" | "parkedMs">;
    stats?: TurnStats;
  },
): void {
  const { now, run, stats } = input;
  const answer = stats?.answer;
  logInfo("turn-summary", {
    requestId: job.requestId,
    runId: job.runId,
    outcome,
    effort: typeof job.effort === "string" ? job.effort : undefined,
    model: answer?.model ?? job.model,
    totalMs: now - job.createdAt,
    queueWaitMs: stats?.queueWaitMs,
    research: stats?.research,
    // From when the turn was asked for, so it includes queueing and research.
    firstTextMs:
      answer?.firstTextAt != null ? answer.firstTextAt - job.createdAt : undefined,
    answerMs: answer ? (answer.endedAt ?? now) - answer.startedAt : undefined,
    finishReason: answer?.finishReason,
    // The answer's tokens only: research calls are not counted here.
    usage: answer?.usage,
    attempts: run.attempts,
    handOvers: run.handOvers,
    continuations: run.continuations,
    // Time spent waiting for a request to continue it.
    parkedMs: run.parkedMs,
  });
}

const INTERRUPTED_MESSAGE =
  "The answer was interrupted on the server before it finished. Please retry.";
const EXHAUSTED_MESSAGE =
  "This request could not be completed after several attempts. Please retry.";

/** Run one attempt of a turn. The caller holds the run lease. Never throws. */
async function runAttempt(job: ChatJob, ctx: DriveContext): Promise<AttemptOutcome> {
  const { db, queue, config, now } = ctx;
  const { runId, chatId, requestId } = job;

  try {
    const before = await readChatRunState(chatId, runId, db);
    if (!before || before.status === "done") {
      // The run ended while it was parked (the user pressed Stop) or has
      // expired. Only the job is left, possibly still holding a queue place.
      await forgetJob(job, { db, queue });
      logInfo("detached-skip", { runId, requestId, reason: "finished" });
      // Ended by a stop, which has no invocation of its own to say so.
      if (before?.cancelled) {
        logTurnSummary(job, "cancelled", { now: now(), run: before });
      }
      return "over";
    }

    const finish = async (
      end: Parameters<typeof endChatRun>[2],
      reason: Exclude<TurnOutcome, "answered" | "failed">,
    ): Promise<AttemptOutcome> => {
      await endChatRun(chatId, runId, end, db);
      await forgetJob(job, { db, queue });
      logInfo("detached-ended", { runId, requestId, reason });
      logTurnSummary(job, reason, { now: now(), run: before });
      return "over";
    };

    if (before.cancelled) return finish({ type: "abort" }, "cancelled");
    if (before.answerStarted) {
      // A previous attempt died mid-answer. Running again would append a
      // second answer to the first, so stop here.
      return finish({ type: "error", errorText: INTERRUPTED_MESSAGE }, "interrupted");
    }
    if (before.attempts >= config.maxAttempts) {
      return finish({ type: "error", errorText: EXHAUSTED_MESSAGE }, "exhausted");
    }

    // Parked until a time that has not come yet: the invocation that parked
    // it could not stay to wait.
    if (before.status === "waiting" && before.wakeAt > now()) {
      return { resumeInMs: before.wakeAt - now() };
    }
    if (now() > ctx.startBy) {
      // Too old to start work. Parking it also shows tailing clients that
      // the run is still in play.
      await parkChatRun(runId, now(), db);
      return "handoff";
    }

    // The run's counters as they will stand once this attempt has begun.
    const run = { ...before, attempts: before.attempts + 1 };
    let continued: { parkedMs: number } | undefined;
    if (ctx.origin !== "start" && ctx.begun === 0) {
      // The invocation that was driving this run handed it over or died.
      // Since then (or since its next attempt fell due) it has been waiting
      // for a request to arrive.
      continued = {
        parkedMs: Math.max(0, now() - Math.max(before.wakeAt, before.updatedAt)),
      };
      run.continuations += 1;
      run.parkedMs += continued.parkedMs;
      logInfo("detached-continued", {
        runId,
        requestId,
        via: ctx.origin,
        from: before.status === "waiting" ? "parked" : "abandoned",
        attempt: run.attempts,
        ageMs: now() - job.createdAt,
        parkedMs: continued.parkedMs,
      });
    }
    ctx.begun += 1;
    await beginChatRunAttempt(runId, db, continued);
    ctx.onEngaged();

    const modelMessages = await convertToModelMessages(job.messages);
    const checkpoint =
      decode<TurnCheckpoint>(await db.get(checkpointKey(runId))) ?? undefined;

    // A turn that has been queued too long stops deferring and fails as busy.
    const queuedTooLong = now() - job.createdAt >= ctx.maxQueueWaitMs;

    const abortController = new AbortController();
    const turn = ctx.startTurn({
      requestId,
      requestedModel: job.model,
      threadId: chatId,
      query: job.query,
      effort: effortConfig(job.effort),
      modelMessages,
      signal: abortController.signal,
      admission: job.ticket
        ? {
            queue,
            ticket: job.ticket,
            deferDelayMs: queuedTooLong ? undefined : config.queuePollDelayMs,
          }
        : undefined,
      emitStart: before.chunkCount === 0,
      checkpoint,
      saveCheckpoint: async (value) => {
        await db.set(checkpointKey(runId), JSON.stringify(value), {
          ex: config.jobTtlSeconds,
        });
      },
      maxDeferMs: config.maxDeferMs,
      answerBy: ctx.startBy,
      finishBy: ctx.finishBy,
    });
    if (isResolutionError(turn)) {
      return finish({ type: "error", errorText: turn.error }, "misconfigured");
    }

    // The run's buffer in Redis is the attempt's only output.
    await ingestChunkStream(
      { chatId, runId, abortController },
      turn.stream,
      {
        lease: ctx.lease,
        wakeAt: turn.deferral.then((deferred) =>
          deferred ? now() + deferred.delayMs : undefined,
        ),
      },
      db,
    );

    const deferral = await turn.deferral;
    if (deferral) {
      const { reason, delayMs } = deferral;
      // Waiting in line is not an attempt at the work.
      if (reason === "queued") await refundChatRunAttempt(runId, db);
      logInfo("detached-deferred", { runId, requestId, reason, delayMs });
      return reason === "handoff" ? "handoff" : { resumeInMs: delayMs };
    }

    // The turn gave its research slot back when its stream closed.
    await db.del(jobKey(runId), checkpointKey(runId));
    logInfo("detached-done", { runId, requestId, attempt: run.attempts });
    logTurnSummary(
      job,
      abortController.signal.aborted
        ? "cancelled"
        : turn.stats.failed
          ? "failed"
          : "answered",
      { now: now(), run, stats: turn.stats },
    );
    return "over";
  } catch (error) {
    logError("detached-attempt", error, { runId, requestId });
    return "failed";
  }
}

/**
 * Every retry of an attempt threw. End the run with an error, so the user
 * is told instead of watching a stream that has gone quiet.
 */
async function abandonRun(job: ChatJob, ctx: DriveContext): Promise<void> {
  const { db, queue } = ctx;
  const state = await readChatRunState(job.chatId, job.runId, db);
  if (state && state.status !== "done") {
    await endChatRun(
      job.chatId,
      job.runId,
      {
        type: "error",
        errorText: state.answerStarted ? INTERRUPTED_MESSAGE : EXHAUSTED_MESSAGE,
      },
      db,
    );
  }
  await forgetJob(job, { db, queue });
  logInfo("detached-failed", { runId: job.runId, requestId: job.requestId });
  if (state) {
    logTurnSummary(job, state.answerStarted ? "interrupted" : "exhausted", {
      now: ctx.now(),
      run: state,
    });
  }
}

/**
 * Drive a run from this invocation: run its attempts, waiting in between,
 * until it is over or the invocation is too old to go on. Does nothing if
 * another invocation is driving it. Never throws.
 */
export async function driveDetachedTurn(
  runId: string,
  invocation: Invocation & { onEngaged?: () => void },
  deps: DriveDeps = {},
): Promise<DriveResult> {
  const config: DriveConfig = { ...serverConfig.detached, ...deps.config };
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? sleepFor;
  const lease = {
    key: runLeaseKey(runId),
    token: crypto.randomUUID(),
    ttlSeconds: config.runLeaseSeconds,
  };
  let db: Db | undefined;
  let claimed = false;

  try {
    db = deps.db ?? defaultDb();
    const job = decode<ChatJob>(await db.get(jobKey(runId)));
    // A run's job goes when the run ends.
    if (!job) return "done";

    // A held lease means another invocation is driving the run, or died
    // moments ago; in that case the lease lapses and a later look gets it.
    claimed = Boolean(
      await db.set(lease.key, lease.token, { nx: true, ex: lease.ttlSeconds }),
    );
    if (!claimed) return "busy";

    const ctx: DriveContext = {
      db,
      queue: deps.queue ?? sharedAdmissionQueue(),
      config,
      now,
      startTurn: deps.startTurn ?? startTurn,
      maxQueueWaitMs: deps.maxQueueWaitMs ?? serverConfig.admission.maxQueueWaitMs,
      origin: invocation.origin,
      lease,
      startBy: invocation.startedAt + config.handoffAfterMs,
      finishBy:
        invocation.startedAt + config.invocationLimitMs - config.finishMarginMs,
      begun: 0,
      onEngaged: () => invocation.onEngaged?.(),
    };
    const handOver = async (reason: string): Promise<DriveResult> => {
      logInfo("detached-handed-over", { runId, requestId: job.requestId, reason });
      try {
        await countChatRunHandOver(runId, ctx.db);
      } catch (error) {
        // Only the summary's count is lost.
        logError("detached-hand-over-count", error, { runId });
      }
      return "handed-over";
    };

    let failures = 0;
    for (;;) {
      const outcome = await runAttempt(job, ctx);
      if (outcome === "over") return "done";
      if (outcome === "handoff") return handOver("invocation-age");

      let delayMs: number;
      if (outcome === "failed") {
        failures += 1;
        if (failures > config.retries) {
          await abandonRun(job, ctx);
          return "done";
        }
        delayMs = config.retryDelayMs * failures;
      } else {
        failures = 0;
        delayMs = outcome.resumeInMs;
      }
      if (delayMs <= 0) continue;

      if (now() + delayMs > ctx.startBy) {
        // The wait would outlast this invocation's time for starting work.
        // A deferred attempt has already parked the run; a failed one has not.
        if (outcome === "failed") await parkChatRun(runId, now() + delayMs, db);
        return handOver("wait");
      }
      // Nothing renews the lease during the wait, so make it cover it.
      await db.set(lease.key, lease.token, {
        ex: Math.ceil(delayMs / 1_000) + lease.ttlSeconds,
      });
      ctx.onEngaged();
      await sleep(delayMs);
    }
  } catch (error) {
    logError("detached-drive", error, { runId });
    return "handed-over";
  } finally {
    if (db && claimed) {
      try {
        // Only if it is still ours: had it lapsed, another invocation may
        // be driving the run by now.
        if ((await db.get<string>(lease.key)) === lease.token) await db.del(lease.key);
      } catch (error) {
        logError("detached-lease-release", error, { runId });
      }
    }
  }
}

/** A request's part in keeping a run moving. Neither promise rejects. */
type Tending = {
  /**
   * Settles once the run is visibly in someone's hands: this invocation has
   * taken it on, or found another driving it, or there is nothing to drive.
   */
  ready: Promise<void>;
  /** Settles when this invocation has nothing more to do for the run. */
  finished: Promise<DriveResult>;
};

/**
 * Drive a run from this invocation if nobody else is. With `watch`, keep
 * checking on it until `watch` aborts, and take it over should its driver
 * stop; without, look once.
 */
function tendDetachedTurn(
  runId: string,
  invocation: Invocation & { watch?: AbortSignal },
  deps: DriveDeps,
): Tending {
  const { watch } = invocation;
  const sleep = deps.sleep ?? sleepFor;
  const watchIntervalMs =
    deps.config?.watchIntervalMs ?? serverConfig.detached.watchIntervalMs;

  let markReady!: () => void;
  const ready = new Promise<void>((resolve) => {
    markReady = resolve;
  });
  const finished = (async (): Promise<DriveResult> => {
    try {
      for (;;) {
        const result = await driveDetachedTurn(
          runId,
          { origin: invocation.origin, startedAt: invocation.startedAt, onEngaged: markReady },
          deps,
        );
        markReady();
        if (result !== "busy" || !watch || watch.aborted) return result;
        await sleep(watchIntervalMs, watch);
        if (watch.aborted) return result;
      }
    } finally {
      markReady();
    }
  })();
  return { ready, finished };
}

/**
 * Serve a request for a run: tail it (or, for `poll`, report it only once
 * it has finished), and keep it moving from this invocation while nobody
 * else does. Resolves to null when there is nothing to send.
 */
export async function tailDetachedTurn(
  input: Invocation & {
    chatId: string;
    runId: string;
    /** Aborts when the client goes away. */
    signal: AbortSignal;
    /** Keeps the invocation alive for work that outlives the response (`after`). */
    keepAlive: (work: Promise<unknown>) => void;
  },
  deps: DriveDeps = {},
): Promise<Response | null> {
  const { chatId, runId, origin } = input;
  const db = deps.db ?? defaultDb();
  // Aborted once this request is finished with the run: its tail has
  // closed, or has to.
  const released = new AbortController();
  const watch = AbortSignal.any([input.signal, released.signal]);

  const tend = (): Tending => {
    const tending = tendDetachedTurn(
      runId,
      {
        origin,
        startedAt: input.startedAt,
        // A poll gets its answer straight away and has no tail to watch for.
        watch: origin === "poll" ? undefined : watch,
      },
      deps,
    );
    input.keepAlive(
      tending.finished.then((result) => {
        // The run is unfinished and this invocation can do no more for it.
        // Ending the tail without a closing frame makes the browser
        // reconnect, and the request it sends takes the run on.
        if (result === "handed-over") released.abort();
      }),
    );
    return tending;
  };

  try {
    if (origin === "poll") {
      await tend().ready;
      return await resumeChatStream(chatId, input.signal, { onlyDone: true, runId }, db);
    }

    // A run that nobody is driving is taken on before it is read. Read
    // first, it could pass for dead.
    if (origin === "resume") await tend().ready;
    const response = await resumeChatStream(
      chatId,
      watch,
      { runId, onClose: () => released.abort() },
      db,
    );
    // A new run has no one to take over from, so its tail comes first: if
    // that fails, nothing has been started.
    if (origin === "start") tend();
    if (!response) released.abort();
    return response;
  } catch (error) {
    released.abort();
    throw error;
  }
}
