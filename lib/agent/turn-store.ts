import "server-only";
import { serverConfig } from "@/lib/config";
import { decodeStoredJson } from "@/lib/json";
import { logError, logInfo } from "@/lib/logger";
import { redis } from "@/lib/redis";
import {
  CHAT_ID_REGEX,
  type ChatMessage,
  type DurableTurnState,
  type ResearchSource,
  type ResearchStepData,
  type TurnWaitState,
} from "@/lib/types/chat";

/**
 * Durable JSON turn store in Upstash Redis.
 *
 * Each generation writes self-contained JSON snapshots to `chat:run:{runId}`
 * (TTL 30m) while `chat:active:{chatId}` points to the latest `runId`.
 * Clients can reload, switch tabs, or switch threads and poll `GET /api/chat/:id`
 * at any point to observe live queue/budget waits, research steps, or the finished answer.
 */
export type TurnStoreDb = {
  get: <T = unknown>(key: string) => Promise<T | null>;
  set: (key: string, value: string, opts?: { ex?: number }) => Promise<unknown>;
};

const STOP_TTL_SECONDS = 10 * 60;
const PRE_STOP_TTL_SECONDS = 2 * 60;

const defaultDb = (): TurnStoreDb => redis() as unknown as TurnStoreDb;

const activeKey = (chatId: string) => `chat:active:${chatId}`;
const runKey = (runId: string) => `chat:run:${runId}`;
const stopRunKey = (runId: string) => `chat:stop:${runId}`;
const stopTurnKey = (chatId: string, turnId: string) =>
  `chat:stop-turn:${chatId}:${turnId}`;

/** Serialize in-process updates to the same `runId` so heartbeats never clobber completions. */
const runLocks = new Map<string, Promise<unknown>>();

function withRunLock<T>(runId: string, fn: () => Promise<T>): Promise<T> {
  const prev = runLocks.get(runId) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  const settled = next.then(
    () => {
      if (runLocks.get(runId) === settled) runLocks.delete(runId);
    },
    () => {
      if (runLocks.get(runId) === settled) runLocks.delete(runId);
    },
  );
  runLocks.set(runId, settled);
  return next;
}

export function isChatId(value: string): boolean {
  return CHAT_ID_REGEX.test(value);
}

export function isTurnId(value: unknown): value is string {
  return typeof value === "string" && /^[\w-]{1,120}$/.test(value);
}

export async function startDurableTurn(
  chatId: string,
  turnId?: string,
  opts?: { db?: TurnStoreDb; now?: () => number },
): Promise<{ state: DurableTurnState; preStopped: boolean }> {
  const db = opts?.db ?? defaultDb();
  const now = (opts?.now ?? Date.now)();
  const runId = `r_${crypto.randomUUID()}`;
  const validTurnId = isTurnId(turnId) ? turnId : undefined;

  const [prevRunId, preStopVal] = await Promise.all([
    db.get<string>(activeKey(chatId)),
    validTurnId ? db.get<string>(stopTurnKey(chatId, validTurnId)) : Promise.resolve(null),
  ]);
  const preStopped = String(preStopVal ?? "") === "1";

  if (prevRunId) {
    await db.set(stopRunKey(prevRunId), "1", { ex: STOP_TTL_SECONDS });
  }

  const state: DurableTurnState = {
    runId,
    chatId,
    ...(validTurnId ? { turnId: validTurnId } : {}),
    status: preStopped ? "stopped" : "running",
    steps: [],
    sources: [],
    updatedAt: now,
  };

  const ttl = serverConfig.turn.ttlSeconds;
  await Promise.all([
    db.set(runKey(runId), JSON.stringify(state), { ex: ttl }),
    db.set(activeKey(chatId), runId, { ex: ttl }),
  ]);

  logInfo("turn-start", {
    chatId,
    runId,
    superseded: Boolean(prevRunId),
    preStopped,
  });
  return { state, preStopped };
}

export async function updateDurableTurnProgress(
  runId: string,
  progress: { steps: ResearchStepData[]; sources: ResearchSource[] },
  opts?: { db?: TurnStoreDb; now?: () => number },
): Promise<void> {
  const db = opts?.db ?? defaultDb();
  const now = (opts?.now ?? Date.now)();
  await withRunLock(runId, async () => {
    try {
      const existing = decodeStoredJson<DurableTurnState>(await db.get(runKey(runId)));
      if (!existing || existing.status !== "running") return;
      const { wait: _cleared, ...rest } = existing;
      const next: DurableTurnState = {
        ...rest,
        steps: progress.steps,
        sources: progress.sources,
        updatedAt: now,
      };
      await db.set(runKey(runId), JSON.stringify(next), {
        ex: serverConfig.turn.ttlSeconds,
      });
    } catch (error) {
      logError("turn-progress-write", error, { runId });
    }
  });
}

export async function updateDurableTurnWait(
  runId: string,
  wait: TurnWaitState | null,
  opts?: { db?: TurnStoreDb; now?: () => number },
): Promise<void> {
  const db = opts?.db ?? defaultDb();
  const now = (opts?.now ?? Date.now)();
  await withRunLock(runId, async () => {
    try {
      const existing = decodeStoredJson<DurableTurnState>(await db.get(runKey(runId)));
      if (!existing || existing.status !== "running") return;
      const { wait: _prev, ...rest } = existing;
      const next: DurableTurnState = {
        ...rest,
        ...(wait ? { wait } : {}),
        updatedAt: now,
      };
      await db.set(runKey(runId), JSON.stringify(next), {
        ex: serverConfig.turn.ttlSeconds,
      });
    } catch (error) {
      logError("turn-wait-write", error, { runId });
    }
  });
}

export type TurnCompletion =
  | {
      status: "done";
      message: ChatMessage;
      steps: ResearchStepData[];
      sources: ResearchSource[];
    }
  | {
      status: "error";
      error: string;
      steps: ResearchStepData[];
      sources: ResearchSource[];
    }
  | {
      status: "stopped";
      steps: ResearchStepData[];
      sources: ResearchSource[];
    };

export async function finishDurableTurn(
  chatId: string,
  runId: string,
  completion: TurnCompletion,
  opts?: { db?: TurnStoreDb; now?: () => number; turnId?: string },
): Promise<DurableTurnState> {
  const db = opts?.db ?? defaultDb();
  const now = (opts?.now ?? Date.now)();

  return withRunLock(runId, async () => {
    const existing = decodeStoredJson<DurableTurnState>(await db.get(runKey(runId)));

    const resolvedTurnId = existing?.turnId ?? (isTurnId(opts?.turnId) ? opts?.turnId : undefined);
    const [runStopped, turnStopped] = await Promise.all([
      db.get<string>(stopRunKey(runId)),
      resolvedTurnId
        ? db.get<string>(stopTurnKey(existing?.chatId ?? chatId, resolvedTurnId))
        : Promise.resolve(null),
    ]);
    const wasStopped =
      existing?.status === "stopped" ||
      String(runStopped ?? "") === "1" ||
      String(turnStopped ?? "") === "1";

    // Never overwrite an explicit user Stop/supersede with a late completion/error.
    if (wasStopped && completion.status !== "stopped") {
      if (existing?.status === "stopped") return existing;
      const stoppedState: DurableTurnState = {
        runId,
        chatId: existing?.chatId ?? chatId,
        ...(resolvedTurnId ? { turnId: resolvedTurnId } : {}),
        status: "stopped",
        steps: existing?.steps ?? completion.steps,
        sources: existing?.sources ?? completion.sources,
        updatedAt: now,
      };
      await db.set(runKey(runId), JSON.stringify(stoppedState), {
        ex: serverConfig.turn.ttlSeconds,
      });
      return stoppedState;
    }

    const base = {
      runId,
      chatId: existing?.chatId ?? chatId,
      ...(resolvedTurnId ? { turnId: resolvedTurnId } : {}),
      steps: completion.steps,
      sources: completion.sources,
      updatedAt: now,
    };

    const state: DurableTurnState =
      completion.status === "done"
        ? { ...base, status: "done", message: completion.message }
        : completion.status === "error"
          ? { ...base, status: "error", error: completion.error }
          : { ...base, status: "stopped" };

    await db.set(runKey(runId), JSON.stringify(state), {
      ex: serverConfig.turn.ttlSeconds,
    });
    logInfo("turn-finish", { chatId, runId, status: state.status });
    return state;
  });
}

export async function stopDurableTurn(
  chatId: string,
  turnId?: string,
  opts?: { db?: TurnStoreDb; now?: () => number },
): Promise<boolean> {
  const db = opts?.db ?? defaultDb();
  const now = (opts?.now ?? Date.now)();
  const validTurnId = isTurnId(turnId) ? turnId : undefined;

  if (validTurnId) {
    await db.set(stopTurnKey(chatId, validTurnId), "1", {
      ex: PRE_STOP_TTL_SECONDS,
    });
  }

  const runId = await db.get<string>(activeKey(chatId));
  if (!runId) return Boolean(validTurnId);

  return withRunLock(runId, async () => {
    const existing = decodeStoredJson<DurableTurnState>(await db.get(runKey(runId)));
    if (validTurnId && existing && existing.turnId !== validTurnId) {
      return true;
    }

    await db.set(stopRunKey(runId), "1", { ex: STOP_TTL_SECONDS });
    if (existing && existing.status === "running") {
      const { wait: _cleared, ...rest } = existing;
      await db.set(
        runKey(runId),
        JSON.stringify({ ...rest, status: "stopped", updatedAt: now }),
        { ex: serverConfig.turn.ttlSeconds },
      );
    }
    logInfo("turn-stop", { chatId, runId, turnId: validTurnId });
    return true;
  });
}

export async function isTurnCancelled(
  chatId: string,
  runId: string,
  db: TurnStoreDb = defaultDb(),
  turnId?: string,
): Promise<boolean> {
  try {
    const validTurnId = isTurnId(turnId) ? turnId : undefined;
    const [stopped, active, turnStopped] = await Promise.all([
      db.get<string>(stopRunKey(runId)),
      db.get<string>(activeKey(chatId)),
      validTurnId ? db.get<string>(stopTurnKey(chatId, validTurnId)) : Promise.resolve(null),
    ]);
    return (
      String(stopped ?? "") === "1" ||
      String(turnStopped ?? "") === "1" ||
      Boolean(active && active !== runId)
    );
  } catch (error) {
    logError("turn-cancel-check", error, { chatId, runId });
    return false;
  }
}

/**
 * Periodically checks Redis for remote stop/supersede signals and refreshes
 * `updatedAt` on the running turn so readers know the worker is still alive
 * even during long queue or token-budget waits.
 */
export function watchDurableTurn(
  chatId: string,
  runId: string,
  controller: AbortController,
  opts?: { db?: TurnStoreDb; intervalMs?: number; now?: () => number; turnId?: string },
): () => void {
  const db = opts?.db ?? defaultDb();
  const nowFn = opts?.now ?? Date.now;
  const intervalMs = opts?.intervalMs ?? serverConfig.turn.heartbeatMs;
  let busy = false;

  const timer = setInterval(() => {
    if (busy || controller.signal.aborted) return;
    busy = true;
    void (async () => {
      try {
        if (await isTurnCancelled(chatId, runId, db, opts?.turnId)) {
          controller.abort();
          return;
        }
        await withRunLock(runId, async () => {
          const existing = decodeStoredJson<DurableTurnState>(await db.get(runKey(runId)));
          if (existing && existing.status === "running") {
            await db.set(
              runKey(runId),
              JSON.stringify({ ...existing, updatedAt: nowFn() }),
              { ex: serverConfig.turn.ttlSeconds },
            );
          }
        });
      } catch (error) {
        logError("turn-heartbeat", error, { chatId, runId });
      } finally {
        busy = false;
      }
    })();
  }, intervalMs);
  (timer as { unref?: () => void }).unref?.();

  return () => clearInterval(timer);
}

const INTERRUPTED_ERROR =
  "The request was interrupted on the server before it finished. Please retry.";

export async function readDurableTurn(
  chatId: string,
  opts?: { db?: TurnStoreDb; now?: () => number },
): Promise<DurableTurnState | null> {
  const db = opts?.db ?? defaultDb();
  const now = (opts?.now ?? Date.now)();
  const runId = await db.get<string>(activeKey(chatId));
  if (!runId) return null;

  const state = decodeStoredJson<DurableTurnState>(await db.get(runKey(runId)));
  if (!state) return null;

  if (
    state.status === "running" &&
    now - state.updatedAt > serverConfig.turn.staleMs
  ) {
    return {
      ...state,
      wait: undefined,
      status: "error",
      error: INTERRUPTED_ERROR,
    };
  }

  return state;
}
