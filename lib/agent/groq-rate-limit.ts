import "server-only";
import type { GroqProviderSettings } from "@ai-sdk/groq";
import { abortableSleep } from "@/lib/errors";
import { redis } from "@/lib/redis";
import { serverConfig } from "@/lib/config";
import { logError, logInfo } from "@/lib/logger";
import type { BudgetDimension, GroqBudget } from "./groq-budget";
import {
  groqReasoningOptions,
  maxSummaryBatchInputChars,
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

export type CooldownEntry = {
  untilMs: number;
  /** True for daily quotas (`RPD` / `TPD`) or retired/decommissioned models (`retired:`). */
  daily: boolean;
  retired?: boolean;
};

const COOLDOWN_KEY_PREFIX = "ratelimit:groq:cooldown:";
const WAKE_BUFFER_MS = 150;
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

function parseGroqRateLimitHeaders(headers: Headers): {
  limitTokens?: number;
  remainingTokens?: number;
} {
  return {
    limitTokens: headerNumber(headers, "x-ratelimit-limit-tokens"),
    remainingTokens: headerNumber(headers, "x-ratelimit-remaining-tokens"),
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

/**
 * Detect when Groq rejects a model because it has been decommissioned,
 * deprecated, not found (HTTP 404), or blocked/unavailable on the free tier.
 */
export function isModelRetiredResponse(status: number, bodyText: string): boolean {
  if (status === 404) return true;
  if (status !== 400 && status !== 403 && status !== 410 && status !== 422) {
    return false;
  }
  return (
    /model_decommissioned|model_not_found|model_not_active|model_permission/i.test(bodyText) ||
    /\b(?:decommissioned|deprecated|no longer supported|shut ?down)\b/i.test(bodyText) ||
    /model\b[^.\n]{0,80}\b(?:does not exist|not found|not available|do not have access)/i.test(
      bodyText,
    )
  );
}

/**
 * Detect when a small-context model (e.g. 4k-token `allam-2-7b`) rejects a
 * payload for exceeding its context length so a larger-context peer can serve it.
 */
function isContextOverflowResponse(status: number, bodyText: string): boolean {
  if (status === 413) return true;
  if (status !== 400) return false;
  return /context_length_exceeded|maximum context length|please reduce the length of the messages|request too large/i.test(
    bodyText,
  );
}

function encodeCooldown(entry: CooldownEntry): string {
  if (entry.retired) return `retired:${entry.untilMs}`;
  return entry.daily ? `daily:${entry.untilMs}` : String(entry.untilMs);
}

function decodeCooldown(raw: unknown): CooldownEntry | undefined {
  if (raw == null) return undefined;
  const text = String(raw).trim();
  if (!text) return undefined;
  if (text.startsWith("retired:")) {
    const untilMs = Number(text.slice("retired:".length));
    if (!Number.isFinite(untilMs) || untilMs <= 0) return undefined;
    return { untilMs, daily: true, retired: true };
  }
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
  maxTtlSeconds: number,
  resolveDb: () => GroqCooldownDb | undefined,
): Promise<void> {
  const db = resolveDb();
  if (!db) return;

  const ttlSeconds = Math.max(
    1,
    Math.min(maxTtlSeconds, Math.ceil((entry.untilMs - now) / 1_000)),
  );
  try {
    await db.set(cooldownKey(model), encodeCooldown(entry), { ex: ttlSeconds });
  } catch (error) {
    logError("groq-cooldown-write", error, { model });
  }
}

/**
 * Trim `<source N>...</source N>` blocks inside a batched summarizer prompt
 * when failing over from a large-context model onto a small-context peer.
 */
function trimSummaryPromptMessages(
  messages: unknown,
  targetModel: string,
): unknown {
  const maxBatchChars = maxSummaryBatchInputChars(
    targetModel,
    serverConfig.summary.batchInputCharCap,
  );
  if (
    maxBatchChars >= serverConfig.summary.batchInputCharCap ||
    !Array.isArray(messages)
  ) {
    return messages;
  }

  return messages.map((msg) => {
    if (!msg || typeof msg !== "object") return msg;
    const record = msg as Record<string, unknown>;
    if (record.role !== "user" || typeof record.content !== "string") return msg;
    const content = record.content;
    const sourceBlocks = [...content.matchAll(/<source \d+>[\s\S]*?<\/source \d+>/g)];
    if (sourceBlocks.length === 0) {
      return content.length > maxBatchChars
        ? { ...record, content: content.slice(0, maxBatchChars) }
        : msg;
    }
    const perSourceBodyCap = Math.max(
      600,
      Math.floor((maxBatchChars - 800) / sourceBlocks.length),
    );
    const trimmed = content.replace(
      /(Content:\n"""\n)([\s\S]*?)(\n"""\n<\/source \d+>)/g,
      (_full, prefix: string, body: string, suffix: string) =>
        body.length > perSourceBodyCap
          ? `${prefix}${body.slice(0, perSourceBodyCap)}${suffix}`
          : _full,
    );
    return { ...record, content: trimmed };
  });
}

/**
 * Rewrite a Groq `/chat/completions` JSON request body for `targetModel`,
 * normalizing `max_completion_tokens`, `reasoning_effort`, `reasoning_format`,
 * and small-context summary batch sizes.
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
  const groqOpts = groqReasoningOptions(targetModel, role);

  parsed.model = targetModel;

  if (!groqOpts) {
    delete parsed.reasoning_format;
    delete parsed.reasoning_effort;
  } else {
    if (groqOpts.groq.reasoningFormat) {
      parsed.reasoning_format = groqOpts.groq.reasoningFormat;
    } else {
      delete parsed.reasoning_format;
    }

    if (groqOpts.groq.reasoningEffort) {
      if (
        stage === "synthesis" &&
        (parsed.reasoning_effort === "low" || parsed.reasoning_effort === "medium") &&
        maxSynthesisOutputTokens(targetModel, synthesisDefaultMaxTokens) >= 1_500
      ) {
        // Preserve caller-chosen synthesis reasoning effort across high-OTPM GPT-OSS peers.
      } else {
        parsed.reasoning_effort = groqOpts.groq.reasoningEffort;
      }
    } else {
      delete parsed.reasoning_effort;
    }
  }

  const rawTokenCap =
    typeof parsed.max_completion_tokens === "number"
      ? parsed.max_completion_tokens
      : typeof parsed.max_tokens === "number"
        ? parsed.max_tokens
        : undefined;

  if (rawTokenCap !== undefined) {
    delete parsed.max_tokens;
    if (stage === "synthesis") {
      parsed.max_completion_tokens = maxSynthesisOutputTokens(
        targetModel,
        synthesisDefaultMaxTokens,
      );
    } else if (stage === "summary") {
      parsed.max_completion_tokens = Math.min(
        rawTokenCap,
        maxSummaryOutputTokens(targetModel, serverConfig.summary.batchMaxOutputTokens),
      );
    } else {
      parsed.max_completion_tokens = rawTokenCap;
    }
  }

  if (stage === "summary") {
    parsed.messages = trimSummaryPromptMessages(parsed.messages, targetModel);
  }

  return JSON.stringify(parsed);
}

export type ResilientGroqFetchOptions = {
  stage: GroqStage;
  primaryModel: string;
  fallbackModels?: string[];
  maxWaitMs?: number;
  maxCooldownSeconds?: number;
  retiredModelTtlSeconds?: number;
  synthesisMaxOutputTokens?: number;
  db?: GroqCooldownDb | null;
  budget?: Pick<GroqBudget, "observe">;
  onWait?: (stage: GroqStage, resumeAt: number | null) => void | Promise<void>;
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
 * Reactive `fetch` wrapper for `@ai-sdk/groq`: reconciles live rate-limit
 * headers into `GroqBudget`, immediately switches across fungible pool peers on
 * 429s/retirements/context overflows, and waits out rolling per-minute windows
 * when every candidate is cooling down.
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
  const retiredTtlSeconds =
    opts.retiredModelTtlSeconds ?? serverConfig.groqRateLimit.retiredModelTtlSeconds;
  const synthesisMaxTokens =
    opts.synthesisMaxOutputTokens ?? serverConfig.synthesis.maxOutputTokens;
  const baseFetch: GroqFetch = opts.baseFetch ?? globalThis.fetch;
  const nowFn = opts.now ?? Date.now;
  const resolveDb = resolveGroqCooldownDb(opts.db, opts.stage);

  return async (input, init) => {
    const rawBody = typeof init?.body === "string" ? init.body : undefined;
    if (!rawBody) return baseFetch(input, init);

    const signal = init?.signal;
    const cooldowns = await readCooldowns(candidates, nowFn(), resolveDb);

    const activeCooldown = (
      model: string,
    ): { remainingMs: number; daily: boolean; retired?: boolean } | undefined => {
      const entry = cooldowns.get(model);
      if (!entry) return undefined;
      const remainingMs = entry.untilMs - nowFn();
      if (remainingMs <= 0) {
        cooldowns.delete(model);
        return undefined;
      }
      return { remainingMs, daily: entry.daily, retired: entry.retired };
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
    };

    const recordRetired = async (model: string, status: number, bodyText: string) => {
      const currentNow = nowFn();
      const entry: CooldownEntry = {
        untilMs: currentNow + retiredTtlSeconds * 1_000,
        daily: true,
        retired: true,
      };
      cooldowns.set(model, entry);
      await writeCooldown(model, entry, currentNow, retiredTtlSeconds, resolveDb);
      logInfo("groq-model-retired", {
        stage: opts.stage,
        model,
        status,
        detail: bodyText.slice(0, 200),
      });
    };

    const shouldFailoverResponse = async (
      model: string,
      response: Response,
      hasRemainingPeers: boolean,
    ): Promise<boolean> => {
      if (response.status === 429) {
        await record429(model, response);
        return true;
      }
      if (response.ok) return false;

      if (response.status >= 500 && hasRemainingPeers) {
        logInfo("groq-upstream-5xx-switch", {
          stage: opts.stage,
          model,
          status: response.status,
        });
        return true;
      }

      if (
        response.status === 400 ||
        response.status === 403 ||
        response.status === 404 ||
        response.status === 410 ||
        response.status === 413 ||
        response.status === 422
      ) {
        const bodyText = await response.clone().text().catch(() => "");
        if (isModelRetiredResponse(response.status, bodyText)) {
          await recordRetired(model, response.status, bodyText);
          return true;
        }
        if (hasRemainingPeers && isContextOverflowResponse(response.status, bodyText)) {
          logInfo("groq-context-overflow-switch", {
            stage: opts.stage,
            model,
            status: response.status,
          });
          return true;
        }
      }

      return false;
    };

    const dispatch = async (model: string): Promise<Response> => {
      const body = rewriteGroqRequestBody(
        rawBody,
        model,
        opts.stage,
        synthesisMaxTokens,
      );
      const response = await baseFetch(input, { ...init, body });
      if (response.status !== 429) {
        const rate = parseGroqRateLimitHeaders(response.headers);
        if (rate.limitTokens != null || rate.remainingTokens != null) {
          void opts.budget?.observe(model, rate);
        }
      }
      if (response.ok && model !== opts.primaryModel) {
        logInfo("groq-pool-switch", {
          stage: opts.stage,
          from: opts.primaryModel,
          to: model,
          retryAfterMs: primaryTriggerWaitMs,
        });
      }
      return response;
    };

    let lastResponse: Response | undefined;
    const healthyCandidates = candidates.filter((c) => !activeCooldown(c));

    // 1. Try every currently healthy candidate in pool + fallback order without sleeping.
    for (let i = 0; i < healthyCandidates.length; i++) {
      const candidate = healthyCandidates[i];
      if (activeCooldown(candidate)) continue;
      const res = await dispatch(candidate);
      const hasRemainingPeers = i + 1 < healthyCandidates.length;
      if (!(await shouldFailoverResponse(candidate, res, hasRemainingPeers))) {
        return res;
      }
      lastResponse = res;
    }

    // 2. If every candidate is cooling down (not retired/daily), wait out the soonest
    //    rolling window up to `maxWaitMs` (up to 2 wake attempts in case another call beat us).
    if (maxWaitMs > 0) {
      const waitDeadline = nowFn() + maxWaitMs;
      for (let attempt = 0; attempt < 2; attempt++) {
        const currentNow = nowFn();
        const remainingBudget = waitDeadline - currentNow;
        if (remainingBudget <= 0) break;

        const soonest = candidates
          .map((m) => ({ model: m, cd: activeCooldown(m) }))
          .filter(
            (x): x is { model: string; cd: { remainingMs: number; daily: boolean } } =>
              x.cd != null && !x.cd.daily && x.cd.remainingMs <= remainingBudget,
          )
          .sort((a, b) => a.cd.remainingMs - b.cd.remainingMs)[0];

        if (!soonest) break;

        try {
          await opts.onWait?.(opts.stage, currentNow + soonest.cd.remainingMs);
        } catch {
          // ignore
        }
        try {
          await abortableSleep(soonest.cd.remainingMs + WAKE_BUFFER_MS, signal, opts.sleep);
        } finally {
          try {
            await opts.onWait?.(opts.stage, null);
          } catch {
            // ignore
          }
        }
        const res = await dispatch(soonest.model);
        if (!(await shouldFailoverResponse(soonest.model, res, false))) {
          return res;
        }
        lastResponse = res;
      }
    }

    if (lastResponse) return lastResponse;

    // 3. Every candidate was skipped from pre-existing Redis cooldowns beyond `maxWaitMs`.
    if (isSynthesis) {
      const nonRetired = candidates.filter((c) => !activeCooldown(c)?.retired);
      const poolToRank = nonRetired.length > 0 ? nonRetired : candidates;
      const leastCooled =
        [...poolToRank].sort(
          (a, b) => (activeCooldown(a)?.remainingMs ?? 0) - (activeCooldown(b)?.remainingMs ?? 0),
        )[0] ?? opts.primaryModel;
      const res = await dispatch(leastCooled);
      await shouldFailoverResponse(leastCooled, res, false);
      return res;
    }

    const activeWaits = candidates
      .map((m) => activeCooldown(m))
      .filter((cd): cd is NonNullable<typeof cd> => cd != null && !cd.retired)
      .map((cd) => cd.remainingMs)
      .sort((a, b) => a - b);

    if (activeWaits.length === 0) {
      return new Response(
        JSON.stringify({
          error: {
            message: `All configured models in the ${opts.stage} pool have been retired or decommissioned at the provider.`,
            type: "invalid_request_error",
          },
        }),
        { status: 404, headers: { "content-type": "application/json" } },
      );
    }

    const retryAfterSec = Math.max(1, Math.ceil(activeWaits[0] / 1_000));
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
