import "server-only";
import { serverConfig } from "@/lib/config";
import { abortableSleep, createAbortError } from "@/lib/errors";
import { decodeStoredJson } from "@/lib/json";
import { logError, logInfo } from "@/lib/logger";
import { groqModelLimits, type GroqModelLimits } from "@/lib/models";
import { redis } from "@/lib/redis";
import {
  createCooldownStore,
  type CooldownStore,
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
  /** Earliest epoch ms when the next request on this model should start (smooth pacing). */
  paceUntil?: number;
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
  /** Fraction (`0`..`1`] of nominal per-minute limits to book against (safety cushion). */
  utilizationCap?: number;
  /** Smoothly pace calls on a model once its remaining window drops below this ratio (`0`..`1`). */
  paceBelowRatio?: number;
  /** Fraction (`0`..`1`) of consumed minute-share to space subsequent calls by. */
  paceRatio?: number;
}): GroqBudget {
  const nowFn = opts?.now ?? Date.now;
  const seedLimits = opts?.seedLimits ?? groqModelLimits;
  const utilizationCap = Math.min(1, Math.max(0.2, opts?.utilizationCap ?? 1));
  const paceBelowRatio = Math.min(1, Math.max(0, opts?.paceBelowRatio ?? 0));
  const paceRatio = Math.min(1, Math.max(0, opts?.paceRatio ?? 0));
  const memoryFallback = new Map<string, string>();
  const learnedTpm = new Map<string, number>();
  const keyLocks = new Map<string, Promise<unknown>>();

  const withKeyLock = <T>(key: string, fn: () => Promise<T>): Promise<T> => {
    const prev = keyLocks.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    const settled = next.then(
      () => {
        if (keyLocks.get(key) === settled) keyLocks.delete(key);
      },
      () => {
        if (keyLocks.get(key) === settled) keyLocks.delete(key);
      },
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

  const scaleLimit = (raw: number | undefined): number | undefined =>
    raw != null && raw > 0 ? Math.max(100, Math.floor(raw * utilizationCap)) : undefined;

  const rawLimitsFor = (model: string): GroqModelLimits | undefined => {
    const seed = seedLimits(model);
    const tpm = learnedTpm.get(model) ?? seed?.tpm;
    if (tpm == null && seed?.itpm == null && seed?.otpm == null) return undefined;
    return { ...seed, ...(tpm != null ? { tpm } : {}) };
  };

  const effectiveLimitsFor = (model: string): GroqModelLimits | undefined => {
    const raw = rawLimitsFor(model);
    if (!raw) return undefined;
    return {
      ...(raw.tpm != null ? { tpm: scaleLimit(raw.tpm) } : {}),
      ...(raw.itpm != null ? { itpm: scaleLimit(raw.itpm) } : {}),
      ...(raw.otpm != null ? { otpm: scaleLimit(raw.otpm) } : {}),
    };
  };

  return {
    limitsFor: rawLimitsFor,
    reserve(model, cost, reserveOpts) {
      const key = budgetKey(model);
      return withKeyLock(key, async () => {
        const baseLimits = effectiveLimitsFor(model);
        if (!baseLimits) return { granted: true, waitMs: 0 };

        const now = nowFn();
        const stored = await readState(key);
        if (stored?.limitTpm && stored.limitTpm > 0) {
          learnedTpm.set(model, stored.limitTpm);
        }
        const limits = effectiveLimitsFor(model)!;
        const elapsed = stored ? Math.max(0, now - stored.ts) : 60_000;

        const availTpm = limits.tpm ? refilled(stored?.tpm, limits.tpm, elapsed) : undefined;
        const availItpm = limits.itpm ? refilled(stored?.itpm, limits.itpm, elapsed) : undefined;
        const availOtpm = limits.otpm ? refilled(stored?.otpm, limits.otpm, elapsed) : undefined;

        const inCost = Math.max(0, Math.ceil(cost.inputTokens));
        const outCost = Math.max(0, Math.ceil(cost.outputTokens));
        const headroom = Math.max(0, reserveOpts?.tpmHeadroom ?? 0);

        let waitMs =
          stored?.paceUntil && stored.paceUntil > now
            ? Math.ceil(stored.paceUntil - now)
            : 0;

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

        const nextTpm = availTpm != null ? availTpm - debitTpm : undefined;
        const nextItpm = availItpm != null ? availItpm - debitItpm : undefined;
        const nextOtpm = availOtpm != null ? availOtpm - debitOtpm : undefined;

        let paceUntil: number | undefined;
        if (paceRatio > 0 && paceBelowRatio > 0) {
          const shares: number[] = [];
          const remRatios: number[] = [];
          if (limits.tpm && nextTpm != null) {
            shares.push(debitTpm / limits.tpm);
            remRatios.push(nextTpm / limits.tpm);
          }
          if (limits.itpm && nextItpm != null) {
            shares.push(debitItpm / limits.itpm);
            remRatios.push(nextItpm / limits.itpm);
          }
          if (limits.otpm && nextOtpm != null) {
            shares.push(debitOtpm / limits.otpm);
            remRatios.push(nextOtpm / limits.otpm);
          }
          const minRemaining = remRatios.length > 0 ? Math.min(...remRatios) : 1;
          const maxShare = shares.length > 0 ? Math.max(...shares) : 0;
          if (minRemaining < paceBelowRatio && maxShare > 0) {
            const delayMs = Math.round(maxShare * 60_000 * paceRatio);
            if (delayMs >= 250) {
              paceUntil = now + delayMs;
            }
          }
        }

        await writeState(key, {
          ...(nextTpm != null ? { tpm: nextTpm } : {}),
          ...(nextItpm != null ? { itpm: nextItpm } : {}),
          ...(nextOtpm != null ? { otpm: nextOtpm } : {}),
          ...(learnedTpm.has(model) ? { limitTpm: learnedTpm.get(model) } : {}),
          ...(paceUntil != null ? { paceUntil } : {}),
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
        const rawLimits = rawLimitsFor(model);
        const limits = effectiveLimitsFor(model);
        if (!limits || !rawLimits) return;

        const now = nowFn();
        const stored = await readState(key);
        const elapsed = stored ? Math.max(0, now - stored.ts) : 60_000;

        let tpm = limits.tpm ? refilled(stored?.tpm, limits.tpm, elapsed) : undefined;
        let itpm = limits.itpm ? refilled(stored?.itpm, limits.itpm, elapsed) : undefined;
        let otpm = limits.otpm ? refilled(stored?.otpm, limits.otpm, elapsed) : undefined;

        if (tpm != null && obs.remainingTokens != null && Number.isFinite(obs.remainingTokens)) {
          const reserveCushion = Math.max(0, (rawLimits.tpm ?? limits.tpm!) - limits.tpm!);
          const usableRemaining = Math.max(0, obs.remainingTokens - reserveCushion);
          tpm = Math.min(tpm, usableRemaining);
        }
        if (obs.exhausted === "tpm" && tpm != null) tpm = 0;
        if (obs.exhausted === "itpm" && itpm != null) itpm = 0;
        if (obs.exhausted === "otpm" && otpm != null) otpm = 0;

        await writeState(key, {
          ...(tpm != null ? { tpm } : {}),
          ...(itpm != null ? { itpm } : {}),
          ...(otpm != null ? { otpm } : {}),
          ...(learnedTpm.has(model) ? { limitTpm: learnedTpm.get(model) } : {}),
          ...(stored?.paceUntil && stored.paceUntil > now
            ? { paceUntil: stored.paceUntil }
            : {}),
          ts: now,
        });
      });
    },
  };
}

let sharedBudget: GroqBudget | undefined;

export function sharedGroqBudget(): GroqBudget {
  sharedBudget ??= createGroqBudget({
    utilizationCap: serverConfig.groqRateLimit.budgetUtilizationCap,
    paceBelowRatio: serverConfig.groqRateLimit.paceBelowRatio,
    paceRatio: serverConfig.groqRateLimit.paceRatio,
  });
  return sharedBudget;
}

function rotate<T>(items: readonly T[], offset: number): T[] {
  if (items.length <= 1) return [...items];
  const idx = ((offset % items.length) + items.length) % items.length;
  return idx === 0 ? [...items] : [...items.slice(idx), ...items.slice(0, idx)];
}

export type AcquiredPoolModel = {
  modelId: string;
  waitedMs: number;
  /** True when every candidate across both pools is quarantined as retired. */
  allRetired?: boolean;
  /** Remaining ms of the shortest non-retired cooldown when `latestStart` stopped waiting. */
  blockedCooldownMs?: number;
};

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
  cooldownStore?: CooldownStore;
  cooldownDb?: () => GroqCooldownDb | undefined;
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
}): Promise<AcquiredPoolModel> {
  const nowFn = req.now ?? Date.now;
  const random = req.random ?? Math.random;
  const startedAt = nowFn();
  let virtualNow = startedAt;
  const currentTime = () => Math.max(nowFn(), virtualNow);

  const cooldownStore =
    req.cooldownStore ??
    createCooldownStore(req.cooldownDb ? (req.cooldownDb() ?? null) : undefined, req.stage);

  const defaultWait = serverConfig.groqRateLimit.stageMaxWaitMs[req.stage];
  const remainingUntilDeadline =
    req.deadlineAt != null ? Math.max(0, req.deadlineAt - startedAt) : defaultWait;
  const waitCap = Math.min(req.maxWaitMs ?? defaultWait, remainingUntilDeadline);
  const latestStart = startedAt + waitCap;

  const preferPoolWaitMs =
    req.preferPoolWaitMs ??
    serverConfig.groqRateLimit.preferPoolWaitMs[req.stage];
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
  const finish = async (
    modelId: string,
    extra?: Pick<AcquiredPoolModel, "allRetired" | "blockedCooldownMs">,
  ): Promise<AcquiredPoolModel> => {
    if (announced) {
      try {
        await req.onWait?.(req.stage, null);
      } catch {
        // ignore status callback errors
      }
    }
    return { modelId, waitedMs: currentTime() - startedAt, ...extra };
  };

  for (;;) {
    if (req.signal?.aborted) throw createAbortError();
    const now = currentTime();
    const cooldowns = await cooldownStore.read(
      [...primaryPool, ...overflowPool],
      now,
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
      primarySoonest != null &&
      now - startedAt + primarySoonest.waitMs <= preferPoolWaitMs &&
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
      const sleepMs = soonest.waitMs + jitter;
      await abortableSleep(sleepMs, req.signal, req.sleep);
      virtualNow = Math.max(nowFn(), now + sleepMs);
      continue;
    }

    // 4. Deadline reached (or all models on daily/retired limits): surface status to StageRunner.
    const candidates = [...primaryPool, ...overflowPool];
    const nonRetired = candidates.filter((m) => !cooldowns.get(m)?.retired);
    if (nonRetired.length === 0) {
      return finish(candidates[0] ?? "", { allRetired: true });
    }
    const activeCooldownWaits = nonRetired
      .map((m) => cooldowns.get(m))
      .filter((cd): cd is NonNullable<typeof cd> => cd != null)
      .map((cd) => Math.max(100, cd.untilMs - now))
      .sort((a, b) => a - b);
    const ranked = [...nonRetired].sort((a, b) => {
      const wa = cooldowns.get(a)?.untilMs ?? 0;
      const wb = cooldowns.get(b)?.untilMs ?? 0;
      return wa - wb;
    });
    return finish(ranked[0], {
      ...(activeCooldownWaits.length === nonRetired.length
        ? { blockedCooldownMs: activeCooldownWaits[0] }
        : {}),
    });
  }
}
