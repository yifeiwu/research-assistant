import "server-only";
import { APICallError, RetryError, type LanguageModel } from "ai";
import { createGroq, type GroqProviderSettings } from "@ai-sdk/groq";
import { serverConfig } from "@/lib/config";
import { createAbortError } from "@/lib/errors";
import { logInfo } from "@/lib/logger";
import {
  acquirePoolModel,
  sharedGroqBudget,
  type GroqBudget,
} from "./groq-budget";
import {
  createCooldownStore,
  createGroqFetch,
  isContextOverflowResponse,
  isModelRetiredResponse,
  parseExhaustedWindow,
  parseGroqRateLimitHeaders,
  parseGroqRateLimitResponse,
  type GroqCooldownDb,
  type GroqStage,
} from "./groq-rate-limit";
import type { StageRunRequest, StageRunner } from "./stage";

const GROQ_CHAT_COMPLETIONS_URL = "https://api.groq.com/openai/v1/chat/completions";

export type ModelPools = {
  reasoning: string[];
  summarizer: string[];
};

export type ResolvedModels = {
  pools: ModelPools;
  stages: Record<GroqStage, StageRunner>;
};

export type ModelResolutionError = { error: string; status: number };

export function isResolutionError(value: object): value is ModelResolutionError {
  return "error" in value;
}

export type ModelPlan = {
  apiKey: string;
  pools: ModelPools;
};

/**
 * Validate server credentials and resolve the active reasoning and summarizer
 * model pools without instantiating providers.
 */
export function planModels(input?: {
  apiKey?: string;
  pools?: Partial<ModelPools>;
}): ModelPlan | ModelResolutionError {
  const apiKey = input?.apiKey ?? process.env.GROQ_API_KEY;
  if (!apiKey) {
    return {
      error: "GROQ_API_KEY is not set on the server.",
      status: 500,
    };
  }

  const reasoning = (input?.pools?.reasoning ?? serverConfig.reasoningPool).filter(Boolean);
  const summarizer = (input?.pools?.summarizer ?? serverConfig.summarizerPool).filter(Boolean);

  if (reasoning.length === 0 || summarizer.length === 0) {
    return {
      error: "Groq reasoning and summarizer model pools must not be empty.",
      status: 500,
    };
  }

  return {
    apiKey,
    pools: { reasoning, summarizer },
  };
}

/** Process-wide round-robin cursors so consecutive calls spread load evenly across pool peers. */
const sharedPoolCursors = new Map<string, number>();

async function withAttemptTimeout<T>(
  stage: GroqStage,
  timeoutMs: number,
  outerSignal: AbortSignal | undefined,
  fn: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  if (!timeoutMs || timeoutMs <= 0) {
    return fn(outerSignal ?? new AbortController().signal);
  }
  const ctrl = new AbortController();
  let timedOut = false;
  if (outerSignal?.aborted) ctrl.abort(outerSignal.reason);
  const onOuterAbort = () => ctrl.abort(outerSignal?.reason);
  outerSignal?.addEventListener("abort", onOuterAbort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    const err = new Error(
      `Groq ${stage} attempt timed out after ${Math.round(timeoutMs / 1_000)}s`,
    );
    err.name = "TimeoutError";
    ctrl.abort(err);
  }, timeoutMs);
  (timer as { unref?: () => void }).unref?.();

  try {
    return await fn(ctrl.signal);
  } catch (err) {
    if (timedOut && !outerSignal?.aborted) {
      const timeoutErr = new Error(
        `Groq ${stage} attempt timed out after ${Math.round(timeoutMs / 1_000)}s`,
      );
      timeoutErr.name = "TimeoutError";
      throw timeoutErr;
    }
    throw err;
  } finally {
    clearTimeout(timer);
    outerSignal?.removeEventListener("abort", onOuterAbort);
  }
}

/**
 * Build budgeted, pool-backed stage runners:
 * - `synthesis` and `planner` run on `pools.reasoning` (spilling over to
 *   `pools.summarizer` when the reasoning pool is saturated or retired).
 * - `summary` runs on `pools.summarizer` (spilling over to `pools.reasoning`
 *   with synthesis headroom reserved when the summarizer pool is saturated or retired).
 */
export function resolveModels(input?: {
  pools?: Partial<ModelPools>;
  apiKey?: string;
  db?: GroqCooldownDb | null;
  budget?: GroqBudget;
  cursors?: Map<string, number>;
  deadlineAt?: number;
  preferPoolWaitMs?: Partial<Record<GroqStage, number>>;
  stageMaxWaitMs?: Partial<Record<GroqStage, number>>;
  attemptTimeoutMs?: Partial<Record<GroqStage, number>>;
  onWait?: (stage: GroqStage, resumeAt: number | null) => void | Promise<void>;
  now?: () => number;
  baseFetch?: NonNullable<GroqProviderSettings["fetch"]>;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}): ResolvedModels | ModelResolutionError {
  const plan = planModels(input);
  if (isResolutionError(plan)) return plan;
  const { apiKey, pools } = plan;

  const budget = input?.budget ?? sharedGroqBudget();
  const cursors =
    input?.cursors ??
    (input?.db !== undefined || input?.budget !== undefined
      ? new Map<string, number>()
      : sharedPoolCursors);
  const nowFn = input?.now ?? Date.now;
  const cooldownStore = createCooldownStore(input?.db, "pool");
  const maxCooldownSeconds = serverConfig.groqRateLimit.maxCooldownSeconds;
  const retiredTtlSeconds = serverConfig.groqRateLimit.retiredModelTtlSeconds;

  const provider = createGroq({
    apiKey,
    fetch: createGroqFetch(input?.baseFetch),
  });
  const modelCache = new Map<string, LanguageModel>();
  const modelFor = (id: string): LanguageModel => {
    let model = modelCache.get(id);
    if (!model) {
      model = provider(id);
      modelCache.set(id, model);
    }
    return model;
  };

  const stageRouting: Record<GroqStage, { pool: string[]; fallbackPool: string[] }> = {
    synthesis: {
      pool: pools.reasoning,
      fallbackPool: pools.summarizer.filter((m) => m !== "allam-2-7b"),
    },
    planner: { pool: pools.reasoning, fallbackPool: pools.summarizer },
    summary: { pool: pools.summarizer, fallbackPool: pools.reasoning },
  };

  const stageRunner = (stage: GroqStage): StageRunner => {
    const { pool, fallbackPool } = stageRouting[stage];
    const allCandidates = [...new Set([...pool, ...fallbackPool])];
    const defaultAttemptTimeout =
      input?.attemptTimeoutMs?.[stage] ??
      (input?.baseFetch ? 0 : serverConfig.groqRateLimit.attemptTimeoutMs[stage]);

    return {
      async run<T>(req: StageRunRequest<T>): Promise<{ value: T; modelId: string }> {
        const excludedModels = new Set<string>();
        const maxAttempts = allCandidates.length + 2;
        let attempts = 0;
        let firstFailedModel: string | undefined;
        let firstRetryAfterMs = 0;

        for (;;) {
          if (req.signal?.aborted) throw createAbortError();

          const activePrimary = pool.filter((m) => !excludedModels.has(m));
          const activeFallback = fallbackPool.filter((m) => !excludedModels.has(m));
          const primary = activePrimary.length > 0 ? activePrimary : activeFallback;
          const secondary = activePrimary.length > 0 ? activeFallback : [];

          const acquired = await acquirePoolModel({
            stage,
            pool: primary,
            fallbackPool: secondary,
            estInputTokens: req.estInputTokens ?? 500,
            maxOutputTokens: req.maxOutputTokens ?? 500,
            budget,
            cooldownStore,
            cursors,
            deadlineAt: input?.deadlineAt,
            maxWaitMs: input?.stageMaxWaitMs?.[stage],
            preferPoolWaitMs: input?.preferPoolWaitMs?.[stage],
            onWait: input?.onWait,
            signal: req.signal,
            now: nowFn,
            sleep: input?.sleep,
            random: input?.random,
          });

          if (acquired.allRetired) {
            throw new APICallError({
              message: `All configured models in the ${stage} pool have been retired or decommissioned at the provider.`,
              url: GROQ_CHAT_COMPLETIONS_URL,
              requestBodyValues: {},
              statusCode: 404,
            });
          }

          if (acquired.blockedCooldownMs != null && stage !== "synthesis") {
            const retrySec = Math.max(1, Math.ceil(acquired.blockedCooldownMs / 1_000));
            throw new APICallError({
              message: `Rate limit cooldown active for model \`${acquired.modelId}\`. Please try again in ${retrySec}s.`,
              url: GROQ_CHAT_COMPLETIONS_URL,
              requestBodyValues: {},
              statusCode: 429,
              responseHeaders: { "retry-after": String(retrySec) },
            });
          }

          const effectiveTimeout =
            req.timeoutMs && defaultAttemptTimeout > 0
              ? Math.min(req.timeoutMs, defaultAttemptTimeout)
              : (req.timeoutMs ?? defaultAttemptTimeout);

          try {
            const out = await withAttemptTimeout(
              stage,
              effectiveTimeout,
              req.signal,
              (attemptSignal) =>
                req.execute(
                  { model: modelFor(acquired.modelId), modelId: acquired.modelId },
                  attemptSignal,
                ),
            );
            const rate = parseGroqRateLimitHeaders(out.headers);
            if (rate.limitTokens != null || rate.remainingTokens != null) {
              void budget.observe(acquired.modelId, rate);
            }
            if (firstFailedModel && acquired.modelId !== firstFailedModel) {
              logInfo("groq-pool-switch", {
                stage,
                from: firstFailedModel,
                to: acquired.modelId,
                retryAfterMs: firstRetryAfterMs,
              });
            }
            return { value: out.value, modelId: acquired.modelId };
          } catch (rawErr) {
            if (req.signal?.aborted) throw createAbortError();
            const err = RetryError.isInstance(rawErr) ? rawErr.lastError : rawErr;
            attempts += 1;

            const hasRemainingPeers = () =>
              allCandidates.some((m) => m !== acquired.modelId && !excludedModels.has(m));

            if (err instanceof Error && err.name === "TimeoutError") {
              if (hasRemainingPeers() && attempts < maxAttempts) {
                firstFailedModel ??= acquired.modelId;
                excludedModels.add(acquired.modelId);
                logInfo("groq-attempt-timeout-switch", {
                  stage,
                  model: acquired.modelId,
                });
                continue;
              }
              throw err;
            }

            if (APICallError.isInstance(err)) {
              const status = err.statusCode ?? 0;
              const bodyText = err.responseBody ?? err.message;

              if (status === 429) {
                const parsed = parseGroqRateLimitResponse(err.responseHeaders, bodyText);
                if (!firstFailedModel) {
                  firstFailedModel = acquired.modelId;
                  firstRetryAfterMs = parsed.waitMs;
                }
                const now = nowFn();
                const effectiveMs = Math.min(
                  maxCooldownSeconds * 1_000,
                  parsed.daily ? Math.max(parsed.waitMs, 60_000) : parsed.waitMs,
                );
                await cooldownStore.write(
                  acquired.modelId,
                  { untilMs: now + effectiveMs, daily: parsed.daily },
                  now,
                  maxCooldownSeconds,
                );
                const rate = parseGroqRateLimitHeaders(err.responseHeaders);
                await budget.observe(acquired.modelId, {
                  limitTokens: rate.limitTokens,
                  remainingTokens: rate.remainingTokens,
                  exhausted: parsed.daily ? undefined : parseExhaustedWindow(bodyText),
                });
                logInfo("groq-rate-limited", {
                  stage,
                  model: acquired.modelId,
                  waitMs: parsed.waitMs,
                  daily: parsed.daily,
                });

                if (parsed.daily) {
                  excludedModels.add(acquired.modelId);
                  if (hasRemainingPeers() && attempts < maxAttempts) continue;
                  throw err;
                }
                if (acquired.blockedCooldownMs != null || attempts >= maxAttempts) {
                  throw err;
                }
                continue;
              }

              if (isModelRetiredResponse(status, bodyText)) {
                const now = nowFn();
                await cooldownStore.write(
                  acquired.modelId,
                  { untilMs: now + retiredTtlSeconds * 1_000, daily: true, retired: true },
                  now,
                  retiredTtlSeconds,
                );
                logInfo("groq-model-retired", {
                  stage,
                  model: acquired.modelId,
                  status,
                  detail: bodyText.slice(0, 200),
                });
                firstFailedModel ??= acquired.modelId;
                excludedModels.add(acquired.modelId);
                if (
                  allCandidates.some((m) => !excludedModels.has(m)) &&
                  attempts < maxAttempts
                ) {
                  continue;
                }
                throw err;
              }

              if (
                (isContextOverflowResponse(status, bodyText) || status >= 500) &&
                hasRemainingPeers() &&
                attempts < maxAttempts
              ) {
                firstFailedModel ??= acquired.modelId;
                excludedModels.add(acquired.modelId);
                logInfo(
                  status >= 500
                    ? "groq-upstream-5xx-switch"
                    : "groq-context-overflow-switch",
                  { stage, model: acquired.modelId, status },
                );
                continue;
              }
            }

            throw rawErr;
          }
        }
      },
    };
  };

  return {
    pools,
    stages: {
      synthesis: stageRunner("synthesis"),
      planner: stageRunner("planner"),
      summary: stageRunner("summary"),
    },
  };
}
