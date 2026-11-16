import "server-only";
import type { GroqProviderSettings } from "@ai-sdk/groq";
import { abortableSleep } from "@/lib/errors";
import { redis } from "@/lib/redis";
import { serverConfig } from "@/lib/config";
import { logError, logInfo } from "@/lib/logger";
import type { BudgetDimension, GroqBudget } from "./groq-budget";
import {
  groqReasoningOptions,
  maxSummaryOutputTokens,
  maxSynthesisOutputTokens,
  type GroqModelRole,
} from "@/lib/models";

type GroqFetch = NonNullable<GroqProviderSettings["fetch"]>;

export type GroqStage = "synthesis" | "planner" | "summary";

/** Minimal Redis surface needed to read/write per-model cooldowns (injectable for tests). */
export type GroqCooldownDb = {
  set: (key: string, value: string, opts?: { ex?: number }) => Promise<unknown>;
  pipeline: () => {
    get: (key: string) => unknown;
    exec: () => Promise<unknown[]>;
  };
};

export type GroqFallbackEvent = {
  from: string;
  to: string;
  retryAfterMs: number;
};

export type CooldownEntry = {
  untilMs: number;
  daily: boolean;
};

/** Groq's rate-limit response headers, parsed. */
export type GroqRateLimitHeaders = {
  limitTokens?: number;
  remainingTokens?: number;
  resetTokensMs?: number;
  limitRequests?: number;
  remainingRequests?: number;
  resetRequestsMs?: number;
};

const COOLDOWN_KEY_PREFIX = "ratelimit:groq:cooldown:";
const SYNTHESIS_WAKE_BUFFER_MS = 200;
const AUXILIARY_WAKE_BUFFER_MS = 150;
const DEFAULT_429_WAIT_MS = 5_000;

function cooldownKey(modelId: string): string {
  return `${COOLDOWN_KEY_PREFIX}${modelId}`;
}

/** Shared resolver for the Redis cooldown store (failing open if unconfigured). */
export function resolveGroqCooldownDb(
  db: GroqCooldownDb | null | undefined,
  stage: string,
): () => GroqCooldownDb | undefined {
  return () => {
    if (db === null) return undefined;
    if (db) return db;
    try {
      return redis() as unknown as GroqCooldownDb;
    } catch (error) {
      logError("groq-cooldown-redis", error, { stage });
      return undefined;
    }
  };
}

/**
 * Parse Groq duration strings such as `"20.4s"`, `"450ms"`, `"2m59.56s"`, or `"1h2m3s"`,
 * as well as plain numeric seconds from `Retry-After`.
 */
export function parseGroqDurationMs(raw: string | null | undefined): number | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;

  if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
    const secs = Number.parseFloat(trimmed);
    return Number.isFinite(secs) && secs > 0 ? Math.ceil(secs * 1_000) : undefined;
  }

  let totalMs = 0;
  let matched = false;
  for (const match of trimmed.matchAll(/(\d+(?:\.\d+)?)\s*(ms|h|m|s)/gi)) {
    const val = Number.parseFloat(match[1]);
    const unit = match[2].toLowerCase();
    if (!Number.isFinite(val) || val < 0) continue;
    matched = true;
    if (unit === "ms") totalMs += val;
    else if (unit === "s") totalMs += val * 1_000;
    else if (unit === "m") totalMs += val * 60_000;
    else if (unit === "h") totalMs += val * 3_600_000;
  }

  return matched && totalMs > 0 ? Math.ceil(totalMs) : undefined;
}

function headerNumber(headers: Headers, name: string): number | undefined {
  const raw = headers.get(name)?.trim();
  if (!raw) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

function parseGroqRateLimitHeaders(headers: Headers): GroqRateLimitHeaders {
  return {
    limitTokens: headerNumber(headers, "x-ratelimit-limit-tokens"),
    remainingTokens: headerNumber(headers, "x-ratelimit-remaining-tokens"),
    resetTokensMs: parseGroqDurationMs(headers.get("x-ratelimit-reset-tokens")),
    limitRequests: headerNumber(headers, "x-ratelimit-limit-requests"),
    remainingRequests: headerNumber(headers, "x-ratelimit-remaining-requests"),
    resetRequestsMs: parseGroqDurationMs(headers.get("x-ratelimit-reset-requests")),
  };
}

function parseExhaustedWindow(bodyText: string): BudgetDimension | undefined {
  const tagged = /\((OTPM|ITPM|TPM)\)/.exec(bodyText)?.[1];
  if (tagged) return tagged.toLowerCase() as BudgetDimension;
  if (/output tokens per minute/i.test(bodyText)) return "otpm";
  if (/input tokens per minute/i.test(bodyText)) return "itpm";
  if (/tokens per minute/i.test(bodyText)) return "tpm";
  return undefined;
}

/**
 * Extract wait duration and whether a 429 came from a daily quota (`RPD` / `TPD`),
 * where short in-request waiting cannot help.
 */
export function parseGroqRateLimitResponse(
  headers: Headers,
  bodyText: string,
): { waitMs: number; daily: boolean } {
  const remainingRpd = headers.get("x-ratelimit-remaining-requests")?.trim();
  const dailyFromBody = /\b(RPD|TPD)\b|tokens per day|requests per day/i.test(bodyText);
  const daily = dailyFromBody || remainingRpd === "0";

  const retryAfterMs = parseGroqDurationMs(headers.get("retry-after"));
  const bodyRetryMatch = /try again in\s+([0-9hms.\s]+?)(?:\.\s|\.$|$|,)/i.exec(bodyText);
  const bodyWaitMs = parseGroqDurationMs(bodyRetryMatch?.[1]);
  const resetTokensMs = parseGroqDurationMs(headers.get("x-ratelimit-reset-tokens"));
  const resetRequestsMs = parseGroqDurationMs(headers.get("x-ratelimit-reset-requests"));

  const waitMs =
    retryAfterMs ??
    bodyWaitMs ??
    (daily ? resetRequestsMs : undefined) ??
    resetTokensMs ??
    resetRequestsMs ??
    DEFAULT_429_WAIT_MS;

  return { waitMs: Math.max(100, waitMs), daily };
}

function encodeCooldown(entry: CooldownEntry): string {
  return entry.daily ? `daily:${entry.untilMs}` : String(entry.untilMs);
}

function decodeCooldown(raw: unknown): CooldownEntry | undefined {
  if (raw == null) return undefined;
  const text = String(raw).trim();
  if (!text) return undefined;
  const daily = text.startsWith("daily:");
  const untilMs = Number(daily ? text.slice("daily:".length) : text);
  if (!Number.isFinite(untilMs) || untilMs <= 0) return undefined;
  return { untilMs, daily };
}

/** Active per-model cooldowns (model id -> entry), skipping expired ones. */
export async function readCooldowns(
  models: string[],
  now: number,
  resolveDb: () => GroqCooldownDb | undefined,
): Promise<Map<string, CooldownEntry>> {
  const map = new Map<string, CooldownEntry>();
  if (models.length === 0) return map;

  const db = resolveDb();
  if (!db) return map;

  try {
    const pipe = db.pipeline();
    for (const model of models) pipe.get(cooldownKey(model));
    const results = await pipe.exec();
    models.forEach((model, idx) => {
      const decoded = decodeCooldown(results[idx]);
      if (decoded && decoded.untilMs > now) map.set(model, decoded);
    });
  } catch (error) {
    logError("groq-cooldown-read", error, { models });
  }
  return map;
}

async function writeCooldown(
  model: string,
  entry: CooldownEntry,
  now: number,
  maxCooldownSeconds: number,
  resolveDb: () => GroqCooldownDb | undefined,
): Promise<void> {
  const db = resolveDb();
  if (!db) return;

  const ttlSeconds = Math.max(
    1,
    Math.min(maxCooldownSeconds, Math.ceil((entry.untilMs - now) / 1_000)),
  );
  try {
    await db.set(cooldownKey(model), encodeCooldown(entry), { ex: ttlSeconds });
  } catch (error) {
    logError("groq-cooldown-write", error, { model });
  }
}

/**
 * Rewrite a Groq `/chat/completions` JSON request body for `targetModel`,
 * normalizing `reasoning_effort`, `reasoning_format`, and synthesis `max_tokens`.
 */
export function rewriteGroqRequestBody(
  rawBody: string,
  targetModel: string,
  stage: GroqStage,
  synthesisDefaultMaxTokens: number = serverConfig.synthesis.maxOutputTokens,
): string {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    return rawBody;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return rawBody;
  }

  const role: GroqModelRole = stage === "synthesis" ? "synthesis" : "auxiliary";
  const groqOpts = groqReasoningOptions(targetModel, role)?.groq;

  parsed.model = targetModel;

  if (groqOpts?.reasoningFormat) {
    parsed.reasoning_format = groqOpts.reasoningFormat;
  } else {
    delete parsed.reasoning_format;
  }

  if (groqOpts?.reasoningEffort) {
    parsed.reasoning_effort = groqOpts.reasoningEffort;
  } else if (
    stage === "synthesis" &&
    (parsed.reasoning_effort === "low" || parsed.reasoning_effort === "medium") &&
    maxSynthesisOutputTokens(targetModel, synthesisDefaultMaxTokens) >= 1_500
  ) {
    // Preserve caller-chosen synthesis reasoning effort across high-OTPM GPT-OSS fallbacks.
  } else {
    delete parsed.reasoning_effort;
  }

  if (stage === "synthesis" && typeof parsed.max_tokens === "number") {
    parsed.max_tokens = maxSynthesisOutputTokens(
      targetModel,
      synthesisDefaultMaxTokens,
    );
  } else if (stage === "summary" && typeof parsed.max_tokens === "number") {
    parsed.max_tokens = Math.min(
      parsed.max_tokens,
      maxSummaryOutputTokens(targetModel, serverConfig.summary.batchMaxOutputTokens),
    );
  }

  return JSON.stringify(parsed);
}

export type ResilientGroqFetchOptions = {
  stage: GroqStage;
  primaryModel: string;
  fallbackModels?: string[];
  onFallback?: (event: GroqFallbackEvent) => void;
  maxWaitMs?: number;
  maxCooldownSeconds?: number;
  synthesisMaxOutputTokens?: number;
  db?: GroqCooldownDb | null;
  budget?: Pick<GroqBudget, "observe">;
  baseFetch?: GroqFetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

function defaultMaxWaitMs(stage: GroqStage): number {
  switch (stage) {
    case "synthesis":
      return serverConfig.groqRateLimit.synthesisMaxWaitMs;
    case "planner":
      return serverConfig.groqRateLimit.plannerMaxWaitMs;
    case "summary":
      return serverConfig.groqRateLimit.summaryMaxWaitMs;
  }
}

/**
 * Reactive `fetch` wrapper for `@ai-sdk/groq`: reconciles response rate-limit
 * headers into `GroqBudget`, honors short `Retry-After` pauses on `synthesis`,
 * and rewrites/switches to healthy fallback models on unexpected 429s.
 */
export function createResilientGroqFetch(
  opts: ResilientGroqFetchOptions,
): GroqFetch {
  const candidates = [
    opts.primaryModel,
    ...(opts.fallbackModels ?? []).filter((m) => m && m !== opts.primaryModel),
  ];
  const isSynthesis = opts.stage === "synthesis";
  const maxWaitMs = opts.maxWaitMs ?? defaultMaxWaitMs(opts.stage);
  const maxCooldownSeconds =
    opts.maxCooldownSeconds ?? serverConfig.groqRateLimit.maxCooldownSeconds;
  const synthesisMaxTokens =
    opts.synthesisMaxOutputTokens ?? serverConfig.synthesis.maxOutputTokens;
  const baseFetch: GroqFetch = opts.baseFetch ?? globalThis.fetch;
  const nowFn = opts.now ?? Date.now;
  const wakeBufferMs = isSynthesis ? SYNTHESIS_WAKE_BUFFER_MS : AUXILIARY_WAKE_BUFFER_MS;
  const resolveDb = resolveGroqCooldownDb(opts.db, opts.stage);

  return async (input, init) => {
    const rawBody = typeof init?.body === "string" ? init.body : undefined;
    if (!rawBody) return baseFetch(input, init);

    const signal = init?.signal;
    const cooldowns = await readCooldowns(candidates, nowFn(), resolveDb);

    const activeCooldown = (model: string): { remainingMs: number; daily: boolean } | undefined => {
      const entry = cooldowns.get(model);
      if (!entry) return undefined;
      const remainingMs = entry.untilMs - nowFn();
      if (remainingMs <= 0) {
        cooldowns.delete(model);
        return undefined;
      }
      return { remainingMs, daily: entry.daily };
    };

    let primaryTriggerWaitMs = activeCooldown(opts.primaryModel)?.remainingMs ?? 0;

    const record429 = async (model: string, response: Response) => {
      const bodyText = await response.clone().text().catch(() => "");
      const parsed = parseGroqRateLimitResponse(response.headers, bodyText);
      if (model === opts.primaryModel) primaryTriggerWaitMs = parsed.waitMs;
      const currentNow = nowFn();
      const effectiveMs = Math.min(
        maxCooldownSeconds * 1_000,
        parsed.daily ? Math.max(parsed.waitMs, 60_000) : parsed.waitMs,
      );
      const entry: CooldownEntry = { untilMs: currentNow + effectiveMs, daily: parsed.daily };
      cooldowns.set(model, entry);
      await writeCooldown(model, entry, currentNow, maxCooldownSeconds, resolveDb);
      const headers = parseGroqRateLimitHeaders(response.headers);
      await opts.budget?.observe(model, {
        limitTokens: headers.limitTokens,
        remainingTokens: headers.remainingTokens,
        exhausted: parsed.daily ? undefined : parseExhaustedWindow(bodyText),
      });
      logInfo("groq-rate-limited", {
        stage: opts.stage,
        model,
        waitMs: parsed.waitMs,
        daily: parsed.daily,
      });
      return parsed;
    };

    const dispatch = async (model: string): Promise<Response> => {
      const body =
        model === opts.primaryModel
          ? rawBody
          : rewriteGroqRequestBody(rawBody, model, opts.stage, synthesisMaxTokens);
      const response = await baseFetch(input, { ...init, body });
      const rate = parseGroqRateLimitHeaders(response.headers);
      if (rate.limitTokens != null || rate.remainingTokens != null) {
        logInfo("groq-rate-headers", {
          stage: opts.stage,
          model,
          status: response.status,
          ...rate,
        });
        if (response.status !== 429) {
          void opts.budget?.observe(model, {
            limitTokens: rate.limitTokens,
            remainingTokens: rate.remainingTokens,
          });
        }
      }
      if (response.status !== 429 && model !== opts.primaryModel && response.ok) {
        logInfo("groq-fallback", {
          stage: opts.stage,
          from: opts.primaryModel,
          to: model,
          retryAfterMs: primaryTriggerWaitMs,
        });
        opts.onFallback?.({
          from: opts.primaryModel,
          to: model,
          retryAfterMs: primaryTriggerWaitMs,
        });
      }
      return response;
    };

    let lastResponse: Response | undefined;
    let slept = false;

    // 1. On synthesis, prefer waiting out a short primary cooldown before switching models.
    const primaryCd = activeCooldown(opts.primaryModel);
    if (isSynthesis && primaryCd && !primaryCd.daily && primaryCd.remainingMs <= maxWaitMs) {
      slept = true;
      await abortableSleep(primaryCd.remainingMs + wakeBufferMs, signal, opts.sleep);
      const res = await dispatch(opts.primaryModel);
      if (res.status !== 429) return res;
      lastResponse = res;
      await record429(opts.primaryModel, res);
    }

    // 2. Try every currently healthy candidate in priority order.
    for (const candidate of candidates) {
      if (activeCooldown(candidate)) continue;
      const res = await dispatch(candidate);
      if (res.status !== 429) return res;
      lastResponse = res;
      const { waitMs, daily } = await record429(candidate, res);

      if (isSynthesis && candidate === opts.primaryModel && !slept && !daily && waitMs <= maxWaitMs) {
        slept = true;
        await abortableSleep(waitMs + wakeBufferMs, signal, opts.sleep);
        const retryRes = await dispatch(opts.primaryModel);
        if (retryRes.status !== 429) return retryRes;
        lastResponse = retryRes;
        await record429(opts.primaryModel, retryRes);
      }
    }

    // 3. If every candidate was cooling down and a short wait is allowed, sleep once for the soonest.
    if (!slept && maxWaitMs > 0) {
      const soonest = candidates
        .map((m) => ({ model: m, cd: activeCooldown(m) }))
        .filter(
          (x): x is { model: string; cd: { remainingMs: number; daily: boolean } } =>
            x.cd != null && !x.cd.daily && x.cd.remainingMs <= maxWaitMs,
        )
        .sort((a, b) => a.cd.remainingMs - b.cd.remainingMs)[0];

      if (soonest) {
        await abortableSleep(soonest.cd.remainingMs + wakeBufferMs, signal, opts.sleep);
        const res = await dispatch(soonest.model);
        if (res.status !== 429) return res;
        lastResponse = res;
        await record429(soonest.model, res);
      }
    }

    if (lastResponse) return lastResponse;

    // 4. Every candidate was skipped from pre-existing Redis cooldowns.
    if (isSynthesis) {
      const leastCooled =
        [...candidates].sort(
          (a, b) => (activeCooldown(a)?.remainingMs ?? 0) - (activeCooldown(b)?.remainingMs ?? 0),
        )[0] ?? opts.primaryModel;
      const res = await dispatch(leastCooled);
      if (res.status === 429) await record429(leastCooled, res);
      return res;
    }

    const soonestMs =
      candidates
        .map((m) => activeCooldown(m)?.remainingMs ?? DEFAULT_429_WAIT_MS)
        .sort((a, b) => a - b)[0] ?? DEFAULT_429_WAIT_MS;
    const retryAfterSec = Math.max(1, Math.ceil(soonestMs / 1_000));
    return new Response(
      JSON.stringify({
        error: {
          message: `Rate limit cooldown active for model \`${opts.primaryModel}\`. Please try again in ${retryAfterSec}s.`,
          type: "tokens",
        },
      }),
      {
        status: 429,
        headers: {
          "content-type": "application/json",
          "retry-after": String(retryAfterSec),
        },
      },
    );
  };
}
