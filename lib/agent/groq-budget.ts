import "server-only";
import { serverConfig } from "@/lib/config";
import { abortableSleep, createAbortError } from "@/lib/errors";
import { decodeStoredJson } from "@/lib/json";
import { logError, logInfo } from "@/lib/logger";
import { groqModelLimits, type GroqModelLimits } from "@/lib/models";
import { redis } from "@/lib/redis";
import {
  readCooldowns,
  type GroqCooldownDb,
  type GroqStage,
} from "./groq-rate-limit";

export type BudgetDimension = "tpm" | "itpm" | "otpm";

export type BudgetObservation = {
  limitTokens?: number;
  remainingTokens?: number;
  exhausted?: BudgetDimension;
};

export type BudgetStoreDb = {
  get: <T = unknown>(key: string) => Promise<T | null>;
  set: (key: string, value: string, opts?: { ex?: number }) => Promise<unknown>;
};

type StoredBudget = {
  tpm?: number;
  itpm?: number;
  otpm?: number;
  limitTpm?: number;
  ts: number;
};

const BUDGET_KEY_PREFIX = "ratelimit:groq:budget:";
const BUDGET_TTL_SECONDS = 90;
const JITTER_MIN_MS = 80;
const JITTER_SPREAD_MS = 160;

function budgetKey(model: string): string {
  return `${BUDGET_KEY_PREFIX}${model}`;
}

function refilled(
  current: number | undefined,
  limit: number,
  elapsedMs: number,
): number {
  if (current == null || !Number.isFinite(current)) return limit;
  return Math.min(limit, current + elapsedMs * (limit / 60_000));
}

export type GroqBudget = {
  limitsFor(model: string): GroqModelLimits | undefined;
  reserve(
    model: string,
    cost: { inputTokens: number; outputTokens: number },
    opts?: { tpmHeadroom?: number },
  ): Promise<{ granted: boolean; waitMs: number }>;
  observe(model: string, obs: BudgetObservation): Promise<void>;
};

/**
 * Simple Lua-free per-model rolling 60s token budget stored as a single JSON
 * key in Redis (`ratelimit:groq:budget:{model}`), falling back to in-memory
 * state if Redis is unavailable.
 */
export function createGroqBudget(opts?: {
  db?: BudgetStoreDb | null;
  now?: () => number;
  seedLimits?: (model: string) => GroqModelLimits | undefined;
}): GroqBudget {
  const nowFn = opts?.now ?? Date.now;
  const seedLimits = opts?.seedLimits ?? groqModelLimits;
  const memoryFallback = new Map<string, string>();
  const learnedTpm = new Map<string, number>();
  const keyLocks = new Map<string, Promise<unknown>>();

  const withKeyLock = <T>(key: string, fn: () => Promise<T>): Promise<T> => {
    const prev = keyLocks.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    const settled = next.then(
      () => undefined,
      () => undefined,
    );
    keyLocks.set(key, settled);
    return next;
  };

  const resolveDb = (): BudgetStoreDb | undefined => {
    if (opts?.db === null) return undefined;
    if (opts?.db) return opts.db;
    try {
      return redis() as unknown as BudgetStoreDb;
    } catch {
      return undefined;
    }
  };

  const readState = async (key: string): Promise<StoredBudget | undefined> => {
    const db = resolveDb();
    if (db) {
      try {
        const raw = await db.get(key);
        if (raw != null) return decodeStoredJson<StoredBudget>(raw) ?? undefined;
        return undefined;
      } catch (error) {
        logError("groq-budget-read", error, { key });
      }
    }
    const mem = memoryFallback.get(key);
    return mem ? (decodeStoredJson<StoredBudget>(mem) ?? undefined) : undefined;
  };

  const writeState = async (key: string, state: StoredBudget): Promise<void> => {
    const serialized = JSON.stringify(state);
    memoryFallback.set(key, serialized);
    const db = resolveDb();
    if (!db) return;
    try {
      await db.set(key, serialized, { ex: BUDGET_TTL_SECONDS });
    } catch (error) {
      logError("groq-budget-write", error, { key });
    }
  };

  const limitsFor = (model: string): GroqModelLimits | undefined => {
    const seed = seedLimits(model);
    const tpm = learnedTpm.get(model) ?? seed?.tpm;
    if (tpm == null && seed?.itpm == null && seed?.otpm == null) return undefined;
    return { ...seed, ...(tpm != null ? { tpm } : {}) };
  };

  return {
    limitsFor,
    reserve(model, cost, reserveOpts) {
      const key = budgetKey(model);
      return withKeyLock(key, async () => {
        const baseLimits = limitsFor(model);
        if (!baseLimits) return { granted: true, waitMs: 0 };

        const now = nowFn();
        const stored = await readState(key);
        if (stored?.limitTpm && stored.limitTpm > 0) {
          learnedTpm.set(model, stored.limitTpm);
        }
        const limits = limitsFor(model)!;
        const elapsed = stored ? Math.max(0, now - stored.ts) : 60_000;

        const availTpm = limits.tpm ? refilled(stored?.tpm, limits.tpm, elapsed) : undefined;
        const availItpm = limits.itpm ? refilled(stored?.itpm, limits.itpm, elapsed) : undefined;
        const availOtpm = limits.otpm ? refilled(stored?.otpm, limits.otpm, elapsed) : undefined;

        const inCost = Math.max(0, Math.ceil(cost.inputTokens));
        const outCost = Math.max(0, Math.ceil(cost.outputTokens));
        const headroom = Math.max(0, reserveOpts?.tpmHeadroom ?? 0);

        let waitMs = 0;
        const checkDim = (avail: number | undefined, limit: number | undefined, rawCost: number, extra = 0) => {
          if (avail == null || limit == null || limit <= 0) return 0;
          const clampedCost = Math.min(rawCost, limit);
          const need = Math.min(limit, clampedCost + extra);
          if (avail < need) {
            waitMs = Math.max(waitMs, Math.ceil((need - avail) / (limit / 60_000)));
          }
          return clampedCost;
        };

        const debitTpm = checkDim(availTpm, limits.tpm, inCost + outCost, headroom);
        const debitItpm = checkDim(availItpm, limits.itpm, inCost);
        const debitOtpm = checkDim(availOtpm, limits.otpm, outCost);

        if (waitMs > 0) {
          return { granted: false, waitMs };
        }

        await writeState(key, {
          ...(availTpm != null ? { tpm: availTpm - debitTpm } : {}),
          ...(availItpm != null ? { itpm: availItpm - debitItpm } : {}),
          ...(availOtpm != null ? { otpm: availOtpm - debitOtpm } : {}),
          ...(learnedTpm.has(model) ? { limitTpm: learnedTpm.get(model) } : {}),
          ts: now,
        });
        return { granted: true, waitMs: 0 };
      });
    },
    observe(model, obs) {
      const key = budgetKey(model);
      return withKeyLock(key, async () => {
        if (obs.limitTokens != null && Number.isFinite(obs.limitTokens) && obs.limitTokens > 0) {
          learnedTpm.set(model, obs.limitTokens);
        }
        const limits = limitsFor(model);
        if (!limits) return;

        const now = nowFn();
        const stored = await readState(key);
        const elapsed = stored ? Math.max(0, now - stored.ts) : 60_000;

        let tpm = limits.tpm ? refilled(stored?.tpm, limits.tpm, elapsed) : undefined;
        let itpm = limits.itpm ? refilled(stored?.itpm, limits.itpm, elapsed) : undefined;
        let otpm = limits.otpm ? refilled(stored?.otpm, limits.otpm, elapsed) : undefined;

        if (tpm != null && obs.remainingTokens != null && Number.isFinite(obs.remainingTokens)) {
          tpm = Math.min(tpm, Math.max(0, obs.remainingTokens));
        }
        if (obs.exhausted === "tpm" && tpm != null) tpm = 0;
        if (obs.exhausted === "itpm" && itpm != null) itpm = 0;
        if (obs.exhausted === "otpm" && otpm != null) otpm = 0;

        await writeState(key, {
          ...(tpm != null ? { tpm } : {}),
          ...(itpm != null ? { itpm } : {}),
          ...(otpm != null ? { otpm } : {}),
          ...(learnedTpm.has(model) ? { limitTpm: learnedTpm.get(model) } : {}),
          ts: now,
        });
      });
    },
  };
}

let sharedBudget: GroqBudget | undefined;

export function sharedGroqBudget(): GroqBudget {
  sharedBudget ??= createGroqBudget();
  return sharedBudget;
}

function rotate<T>(items: readonly T[], offset: number): T[] {
  if (items.length <= 1) return [...items];
  const idx = ((offset % items.length) + items.length) % items.length;
  return idx === 0 ? [...items] : [...items.slice(idx), ...items.slice(0, idx)];
}

/**
 * Acquire a model from a stage's fungible `pool`, waiting patiently for a
 * rolling 60s token window to reopen (or spilling over to `fallbackPool`)
 * rather than failing with a token-exhaustion error.
 */
export async function acquirePoolModel(req: {
  stage: GroqStage;
  pool: string[];
  fallbackPool: string[];
  estInputTokens: number | ((model: string) => number);
  maxOutputTokens: number | ((model: string) => number);
  budget: GroqBudget;
  cooldownDb: () => GroqCooldownDb | undefined;
  cursors: Map<string, number>;
  deadlineAt?: number;
  maxWaitMs?: number;
  preferPoolWaitMs?: number;
  synthesisReserveTokens?: number;
  onWait?: (stage: GroqStage, resumeAt: number | null) => void | Promise<void>;
  signal?: AbortSignal;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}): Promise<{ modelId: string; waitedMs: number }> {
  const nowFn = req.now ?? Date.now;
  const random = req.random ?? Math.random;
  const startedAt = nowFn();

  const defaultWait = serverConfig.groqRateLimit.stageMaxWaitMs[req.stage];
  const remainingUntilDeadline =
    req.deadlineAt != null ? Math.max(0, req.deadlineAt - startedAt) : defaultWait;
  const waitCap = Math.min(req.maxWaitMs ?? defaultWait, remainingUntilDeadline);
  const latestStart = startedAt + waitCap;

  const preferPoolWaitMs =
    req.preferPoolWaitMs ??
    (req.stage === "synthesis"
      ? serverConfig.groqRateLimit.preferPoolWaitMs
      : 5_000);
  const reserveTokens =
    req.synthesisReserveTokens ?? serverConfig.groqRateLimit.synthesisReserveTokens;

  const basePool = [...new Set(req.pool.filter(Boolean))];
  const overflowPool = [
    ...new Set(req.fallbackPool.filter((m) => m && !basePool.includes(m))),
  ];

  const poolKey = basePool.join(",");
  const offset = req.cursors.get(poolKey) ?? 0;
  if (basePool.length > 1) {
    req.cursors.set(poolKey, (offset + 1) % basePool.length);
  }
  const primaryPool = rotate(basePool, offset);

  const inputFor = (m: string) =>
    typeof req.estInputTokens === "function" ? req.estInputTokens(m) : req.estInputTokens;
  const outputFor = (m: string) =>
    typeof req.maxOutputTokens === "function" ? req.maxOutputTokens(m) : req.maxOutputTokens;

  let announced = false;
  const finish = async (modelId: string) => {
    if (announced) {
      try {
        await req.onWait?.(req.stage, null);
      } catch {
        // ignore status callback errors
      }
    }
    return { modelId, waitedMs: nowFn() - startedAt };
  };

  for (;;) {
    if (req.signal?.aborted) throw createAbortError();
    const now = nowFn();
    const cooldowns = await readCooldowns(
      [...primaryPool, ...overflowPool],
      now,
      req.cooldownDb,
    );

    const tryCandidate = async (
      model: string,
      tpmHeadroom: number,
    ): Promise<{ granted: true } | { granted: false; waitMs: number; retired?: boolean }> => {
      const cd = cooldowns.get(model);
      if (cd) {
        return {
          granted: false,
          waitMs: cd.daily ? Number.POSITIVE_INFINITY : Math.max(100, cd.untilMs - now),
          retired: cd.retired,
        };
      }
      const res = await req.budget.reserve(
        model,
        { inputTokens: inputFor(model), outputTokens: outputFor(model) },
        { tpmHeadroom },
      );
      return res.granted ? { granted: true } : { granted: false, waitMs: res.waitMs };
    };

    // 1. Try every free model in `primaryPool` immediately.
    let primarySoonest: { model: string; waitMs: number; retired?: boolean } | undefined;
    for (const model of primaryPool) {
      const res = await tryCandidate(model, 0);
      if (res.granted) {
        const out = await finish(model);
        if (out.waitedMs > 0) {
          logInfo("groq-budget-granted", { stage: req.stage, model, pool: "primary", waitedMs: out.waitedMs });
        }
        return out;
      }
      if (!primarySoonest || res.waitMs < primarySoonest.waitMs) {
        primarySoonest = { model, waitMs: res.waitMs, retired: res.retired };
      }
    }

    // 2. If `primaryPool` needs longer than `preferPoolWaitMs` (or exceeds our deadline),
    //    check `overflowPool` (keeping synthesis headroom free for auxiliary stages).
    let soonest = primarySoonest;
    const primaryFitsBriefly =
      now === startedAt &&
      primarySoonest != null &&
      primarySoonest.waitMs <= preferPoolWaitMs &&
      now + primarySoonest.waitMs <= latestStart;

    if (!primaryFitsBriefly) {
      const headroom = req.stage === "synthesis" ? 0 : reserveTokens;
      for (const model of overflowPool) {
        const res = await tryCandidate(model, headroom);
        if (res.granted) {
          const out = await finish(model);
          logInfo("groq-budget-granted", { stage: req.stage, model, pool: "overflow", waitedMs: out.waitedMs });
          return out;
        }
        if (!soonest || res.waitMs < soonest.waitMs) {
          soonest = { model, waitMs: res.waitMs, retired: res.retired };
        }
      }
    }

    // 3. Wait for whichever candidate's rolling window opens soonest, when it fits.
    if (soonest && Number.isFinite(soonest.waitMs) && now + soonest.waitMs <= latestStart) {
      announced = true;
      try {
        await req.onWait?.(req.stage, now + soonest.waitMs);
      } catch {
        // ignore status callback errors
      }
      const jitter = JITTER_MIN_MS + Math.floor(random() * JITTER_SPREAD_MS);
      await abortableSleep(soonest.waitMs + jitter, req.signal, req.sleep);
      continue;
    }

    // 4. Deadline reached (or all models on daily/retired limits): pick the best
    //    non-retired candidate and let `createResilientGroqFetch` execute or surface a clean error.
    const candidates = [...primaryPool, ...overflowPool];
    const nonRetired = candidates.filter((m) => !cooldowns.get(m)?.retired);
    return finish(nonRetired[0] ?? primaryPool[0]);
  }
}
