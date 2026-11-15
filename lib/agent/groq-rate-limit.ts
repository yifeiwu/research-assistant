import "server-only";
import type { GroqProviderSettings } from "@ai-sdk/groq";
import { redis } from "@/lib/redis";
import { serverConfig } from "@/lib/config";
import { logError, logInfo } from "@/lib/logger";
import type { BudgetDimension, GroqBudget } from "./groq-budget";
import {
  groqReasoningOptions,
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
  /** Combined tokens-per-minute limit and what is left of it. */
  limitTokens?: number;
  remainingTokens?: number;
  resetTokensMs?: number;
  /** Requests-per-day limit and what is left of it. */
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

/**
 * Parse Groq duration strings such as `"20.4s"`, `"450ms"`, `"2m59.56s"`, or `"1h2m3s"`,
 * as well as plain numeric seconds from `Retry-After`.
 */
export function parseGroqDurationMs(raw: string | null | undefined): number | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;

  // Plain numeric value (e.g. Retry-After: "8" or "8.5") -> seconds.
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
    const secs = Number.parseFloat(trimmed);
    return Number.isFinite(secs) && secs > 0 ? Math.ceil(secs * 1_000) : undefined;
  }

  let totalMs = 0;
  let matched = false;
  const unitRe = /(\d+(?:\.\d+)?)\s*(ms|h|m|s)/gi;
  for (const match of trimmed.matchAll(unitRe)) {
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

/**
 * Read Groq's `x-ratelimit-*` headers. Per Groq's docs the `-tokens` headers
 * always describe the combined tokens-per-minute (TPM) limit and the
 * `-requests` headers always describe requests per day (RPD); separate
 * input/output per-minute limits (ITPM/OTPM) are not reported in headers.
 */
export function parseGroqRateLimitHeaders(headers: Headers): GroqRateLimitHeaders {
  return {
    limitTokens: headerNumber(headers, "x-ratelimit-limit-tokens"),
    remainingTokens: headerNumber(headers, "x-ratelimit-remaining-tokens"),
    resetTokensMs: parseGroqDurationMs(headers.get("x-ratelimit-reset-tokens")),
    limitRequests: headerNumber(headers, "x-ratelimit-limit-requests"),
    remainingRequests: headerNumber(headers, "x-ratelimit-remaining-requests"),
    resetRequestsMs: parseGroqDurationMs(headers.get("x-ratelimit-reset-requests")),
  };
}

/** Which per-minute token window a 429 body says was exhausted, if any. */
export function parseExhaustedWindow(bodyText: string): BudgetDimension | undefined {
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
  const numText = daily ? text.slice("daily:".length) : text;
  const untilMs = Number(numText);
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
    for (const model of models) {
      pipe.get(cooldownKey(model));
    }
    const results = await pipe.exec();
    models.forEach((model, idx) => {
      const decoded = decodeCooldown(results[idx]);
      if (decoded && decoded.untilMs > now) {
        map.set(model, decoded);
      }
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

/** Abort-aware sleep that rejects with `AbortError` immediately if `signal` aborts. */
export function abortableSleep(
  ms: number,
  signal: AbortSignal | null | undefined,
  sleepImpl?: (ms: number) => Promise<void>,
): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(new DOMException("The operation was aborted.", "AbortError"));
  }
  if (ms <= 0) return Promise.resolve();

  if (sleepImpl) {
    return new Promise<void>((resolve, reject) => {
      const onAbort = () =>
        reject(new DOMException("The operation was aborted.", "AbortError"));
      signal?.addEventListener("abort", onAbort, { once: true });
      sleepImpl(ms).then(
        () => {
          signal?.removeEventListener("abort", onAbort);
          if (signal?.aborted) {
            reject(new DOMException("The operation was aborted.", "AbortError"));
          } else {
            resolve();
          }
        },
        (err) => {
          signal?.removeEventListener("abort", onAbort);
          reject(err);
        },
      );
    });
  }

  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("The operation was aborted.", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Rewrite a Groq `/chat/completions` JSON request body for `targetModel`,
 * normalizing `reasoning_effort`, `reasoning_format`, and synthesis `max_tokens`
 * so switching between Qwen (`effort: "none"`, 900 OTPM cap) and GPT-OSS
 * (`effort: "low"`, 3,500 cap) never triggers HTTP 400 or OTPM 429s.
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
  } else {
    delete parsed.reasoning_effort;
  }

  if (stage === "synthesis" && typeof parsed.max_tokens === "number") {
    parsed.max_tokens = maxSynthesisOutputTokens(
      targetModel,
      synthesisDefaultMaxTokens,
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
  /** Shared token budgets to reconcile against each response's headers. */
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
 * Create a `fetch` wrapper for `@ai-sdk/groq` that:
 * 1. Checks Redis per-model cooldowns before firing a request.
 * 2. Sleeps accurately for short `Retry-After` windows (honoring `selectedModel`
 *    on synthesis when wait <= 10s, or brief planner waits when all candidates
 *    are cooling down).
 * 3. Automatically rewrites the payload and falls back to healthy candidate
 *    models on long waits or daily (`RPD`/`TPD`) limits.
 */
export function createResilientGroqFetch(
  opts: ResilientGroqFetchOptions,
): GroqFetch {
  const candidates = [
    opts.primaryModel,
    ...(opts.fallbackModels ?? []).filter((m) => m && m !== opts.primaryModel),
  ];
  const maxWaitMs = opts.maxWaitMs ?? defaultMaxWaitMs(opts.stage);
  const maxCooldownSeconds =
    opts.maxCooldownSeconds ?? serverConfig.groqRateLimit.maxCooldownSeconds;
  const synthesisMaxTokens =
    opts.synthesisMaxOutputTokens ?? serverConfig.synthesis.maxOutputTokens;
  const baseFetch: GroqFetch = opts.baseFetch ?? globalThis.fetch;
  const nowFn = opts.now ?? Date.now;
  const wakeBufferMs =
    opts.stage === "synthesis" ? SYNTHESIS_WAKE_BUFFER_MS : AUXILIARY_WAKE_BUFFER_MS;

  const resolveDb = (): GroqCooldownDb | undefined => {
    if (opts.db === null) return undefined;
    if (opts.db) return opts.db;
    try {
      return redis() as unknown as GroqCooldownDb;
    } catch (error) {
      logError("groq-cooldown-redis", error, { stage: opts.stage });
      return undefined;
    }
  };

  return async (input, init) => {
    const rawBody = typeof init?.body === "string" ? init.body : undefined;
    if (!rawBody) {
      return baseFetch(input, init);
    }

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

    const record429 = async (model: string, response: Response): Promise<{ waitMs: number; daily: boolean }> => {
      const bodyText = await response.clone().text().catch(() => "");
      const parsed = parseGroqRateLimitResponse(response.headers, bodyText);
      const currentNow = nowFn();
      const effectiveMs = Math.min(
        maxCooldownSeconds * 1_000,
        parsed.daily ? Math.max(parsed.waitMs, 60_000) : parsed.waitMs,
      );
      const entry: CooldownEntry = {
        untilMs: currentNow + effectiveMs,
        daily: parsed.daily,
      };
      cooldowns.set(model, entry);
      await writeCooldown(model, entry, currentNow, maxCooldownSeconds, resolveDb);
      // Drain the window Groq says is exhausted so the scheduler stops
      // granting against it; the cooldown above covers the time to reset.
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

    const callModel = (model: string): Promise<Response> => {
      const body =
        model === opts.primaryModel
          ? rawBody
          : rewriteGroqRequestBody(rawBody, model, opts.stage, synthesisMaxTokens);
      return baseFetch(input, { ...init, body });
    };

    let primaryTriggerWaitMs = 0;
    const dispatchAndTrack = async (model: string): Promise<Response> => {
      const response = await callModel(model);
      const rate = parseGroqRateLimitHeaders(response.headers);
      if (rate.limitTokens != null || rate.remainingTokens != null) {
        // Logged on every response so real limits can be read off the logs.
        logInfo("groq-rate-headers", {
          stage: opts.stage,
          model,
          status: response.status,
          ...rate,
        });
        if (response.status !== 429) {
          // 429s are reconciled in `record429`, which also reads the body.
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

    if (opts.stage === "synthesis") {
      return runSynthesisStrategy({
        candidates,
        primaryModel: opts.primaryModel,
        maxWaitMs,
        wakeBufferMs,
        signal,
        sleepImpl: opts.sleep,
        activeCooldown,
        record429: async (model, res) => {
          const info = await record429(model, res);
          if (model === opts.primaryModel) primaryTriggerWaitMs = info.waitMs;
          return info;
        },
        setPrimaryWaitMs: (ms) => {
          primaryTriggerWaitMs = ms;
        },
        dispatch: dispatchAndTrack,
      });
    }

    return runAuxiliaryStrategy({
      candidates,
      primaryModel: opts.primaryModel,
      maxWaitMs,
      wakeBufferMs,
      signal,
      sleepImpl: opts.sleep,
      activeCooldown,
      record429: async (model, res) => {
        const info = await record429(model, res);
        if (model === opts.primaryModel) primaryTriggerWaitMs = info.waitMs;
        return info;
      },
      setPrimaryWaitMs: (ms) => {
        primaryTriggerWaitMs = ms;
      },
      dispatch: dispatchAndTrack,
    });
  };
}

type StrategyDeps = {
  candidates: string[];
  primaryModel: string;
  maxWaitMs: number;
  wakeBufferMs: number;
  signal: AbortSignal | null | undefined;
  sleepImpl?: (ms: number) => Promise<void>;
  activeCooldown: (model: string) => { remainingMs: number; daily: boolean } | undefined;
  record429: (model: string, res: Response) => Promise<{ waitMs: number; daily: boolean }>;
  setPrimaryWaitMs: (ms: number) => void;
  dispatch: (model: string) => Promise<Response>;
};

async function runSynthesisStrategy(deps: StrategyDeps): Promise<Response> {
  const {
    candidates,
    primaryModel,
    maxWaitMs,
    wakeBufferMs,
    signal,
    sleepImpl,
    activeCooldown,
    record429,
    setPrimaryWaitMs,
    dispatch,
  } = deps;

  let sleptMs = 0;
  let lastResponse: Response | undefined;
  const attempted = new Set<string>();

  // 1. Honor `primaryModel` whenever healthy or within the short-wait budget.
  const primaryCd = activeCooldown(primaryModel);
  if (!primaryCd) {
    attempted.add(primaryModel);
    const res = await dispatch(primaryModel);
    if (res.status !== 429) return res;
    lastResponse = res;
    const { waitMs, daily } = await record429(primaryModel, res);
    if (!daily && waitMs <= maxWaitMs) {
      const sleepFor = waitMs + wakeBufferMs;
      sleptMs += sleepFor;
      await abortableSleep(sleepFor, signal, sleepImpl);
      const retryRes = await dispatch(primaryModel);
      if (retryRes.status !== 429) return retryRes;
      lastResponse = retryRes;
      await record429(primaryModel, retryRes);
    }
  } else {
    setPrimaryWaitMs(primaryCd.remainingMs);
    if (!primaryCd.daily && primaryCd.remainingMs <= maxWaitMs) {
      const sleepFor = primaryCd.remainingMs + wakeBufferMs;
      sleptMs += sleepFor;
      await abortableSleep(sleepFor, signal, sleepImpl);
      attempted.add(primaryModel);
      const res = await dispatch(primaryModel);
      if (res.status !== 429) return res;
      lastResponse = res;
      await record429(primaryModel, res);
    }
  }

  // 2. Try healthy fallback candidates immediately (zero wait).
  const fallbacks = candidates.filter((m) => m !== primaryModel);
  for (const candidate of fallbacks) {
    if (activeCooldown(candidate)) continue;
    attempted.add(candidate);
    const res = await dispatch(candidate);
    if (res.status !== 429) return res;
    lastResponse = res;
    await record429(candidate, res);
  }

  // 3. If any unattempted fallback has a short remaining cooldown within the
  // remaining wait budget, sleep for the soonest one and call it.
  const remainingBudget = maxWaitMs - sleptMs;
  if (remainingBudget > 0) {
    const waitable = fallbacks
      .filter((m) => !attempted.has(m))
      .map((m) => ({ model: m, cd: activeCooldown(m) }))
      .filter(
        (x): x is { model: string; cd: { remainingMs: number; daily: boolean } } =>
          x.cd != null && !x.cd.daily && x.cd.remainingMs <= remainingBudget,
      )
      .sort((a, b) => a.cd.remainingMs - b.cd.remainingMs)[0];

    if (waitable) {
      await abortableSleep(waitable.cd.remainingMs + wakeBufferMs, signal, sleepImpl);
      attempted.add(waitable.model);
      const res = await dispatch(waitable.model);
      if (res.status !== 429) return res;
      lastResponse = res;
      await record429(waitable.model, res);
    }
  }

  // 4. Ensure we always have a concrete HTTP response to return if every
  // candidate was skipped solely from pre-existing Redis cooldown entries.
  if (!lastResponse) {
    const leastCooled =
      [...candidates].sort((a, b) => {
        const ca = activeCooldown(a)?.remainingMs ?? 0;
        const cb = activeCooldown(b)?.remainingMs ?? 0;
        return ca - cb;
      })[0] ?? primaryModel;
    const res = await dispatch(leastCooled);
    if (res.status === 429) await record429(leastCooled, res);
    return res;
  }

  return lastResponse;
}

async function runAuxiliaryStrategy(deps: StrategyDeps): Promise<Response> {
  const {
    candidates,
    primaryModel,
    maxWaitMs,
    wakeBufferMs,
    signal,
    sleepImpl,
    activeCooldown,
    record429,
    setPrimaryWaitMs,
    dispatch,
  } = deps;

  const primaryCd = activeCooldown(primaryModel);
  if (primaryCd) {
    setPrimaryWaitMs(primaryCd.remainingMs);
  }

  let lastResponse: Response | undefined;

  // 1. Try every currently healthy candidate in priority order without sleeping.
  for (const candidate of candidates) {
    if (activeCooldown(candidate)) continue;
    const res = await dispatch(candidate);
    if (res.status !== 429) return res;
    lastResponse = res;
    await record429(candidate, res);
  }

  // 2. All candidates are cooling down: if this auxiliary stage allows a short
  // wait (e.g. planner <= 3s), sleep once for the candidate that clears soonest.
  if (maxWaitMs > 0) {
    const soonest = candidates
      .map((m) => ({ model: m, cd: activeCooldown(m) }))
      .filter(
        (x): x is { model: string; cd: { remainingMs: number; daily: boolean } } =>
          x.cd != null && !x.cd.daily && x.cd.remainingMs <= maxWaitMs,
      )
      .sort((a, b) => a.cd.remainingMs - b.cd.remainingMs)[0];

    if (soonest) {
      await abortableSleep(soonest.cd.remainingMs + wakeBufferMs, signal, sleepImpl);
      const res = await dispatch(soonest.model);
      if (res.status !== 429) return res;
      lastResponse = res;
      await record429(soonest.model, res);
    }
  }

  // 3. If every candidate was skipped via Redis cooldowns and we never made an
  // HTTP request (e.g. summaryMaxWaitMs === 0 with all candidates cooled down),
  // synthesize a fast local 429 Response so fail-fast callers (like the batch
  // summarizer) immediately trigger their raw-excerpt fallback without burning
  // another upstream 429 against Groq.
  if (!lastResponse) {
    const soonestMs =
      candidates
        .map((m) => activeCooldown(m)?.remainingMs ?? DEFAULT_429_WAIT_MS)
        .sort((a, b) => a - b)[0] ?? DEFAULT_429_WAIT_MS;
    const retryAfterSec = Math.max(1, Math.ceil(soonestMs / 1_000));
    return new Response(
      JSON.stringify({
        error: {
          message: `Rate limit cooldown active for model \`${primaryModel}\`. Please try again in ${retryAfterSec}s.`,
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
  }

  return lastResponse;
}
