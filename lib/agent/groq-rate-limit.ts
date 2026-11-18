import "server-only";
import type { GroqProviderSettings } from "@ai-sdk/groq";
import { logError } from "@/lib/logger";
import { redis } from "@/lib/redis";
import type { BudgetDimension } from "./groq-budget";

export type GroqFetch = NonNullable<GroqProviderSettings["fetch"]>;

export type GroqStage = "synthesis" | "planner" | "summary";

export type HeaderBag = Headers | Record<string, string | undefined> | undefined;

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

export type CooldownStore = {
  read(models: string[], now: number): Promise<Map<string, CooldownEntry>>;
  write(
    model: string,
    entry: CooldownEntry,
    now: number,
    maxTtlSeconds: number,
  ): Promise<void>;
};

const COOLDOWN_KEY_PREFIX = "ratelimit:groq:cooldown:";
const DEFAULT_429_WAIT_MS = 5_000;

function cooldownKey(modelId: string): string {
  return `${COOLDOWN_KEY_PREFIX}${modelId}`;
}

function readHeader(headers: HeaderBag, name: string): string | undefined {
  if (!headers) return undefined;
  if (typeof (headers as Headers).get === "function") {
    return (headers as Headers).get(name) ?? undefined;
  }
  const record = headers as Record<string, string | undefined>;
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(record)) {
    if (k.toLowerCase() === lower) return v;
  }
  return undefined;
}

function headerNumber(headers: HeaderBag, name: string): number | undefined {
  const raw = readHeader(headers, name)?.trim();
  if (!raw) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
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

export function parseGroqRateLimitHeaders(headers: HeaderBag): {
  limitTokens?: number;
  remainingTokens?: number;
} {
  return {
    limitTokens: headerNumber(headers, "x-ratelimit-limit-tokens"),
    remainingTokens: headerNumber(headers, "x-ratelimit-remaining-tokens"),
  };
}

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
  headers: HeaderBag,
  bodyText: string,
): { waitMs: number; daily: boolean } {
  const remainingRpd = readHeader(headers, "x-ratelimit-remaining-requests")?.trim();
  const dailyFromBody = /\b(RPD|TPD)\b|tokens per day|requests per day/i.test(bodyText);
  const daily = dailyFromBody || remainingRpd === "0";

  const retryAfterMs = parseGroqDurationMs(readHeader(headers, "retry-after"));
  const bodyRetryMatch = /try again in\s+([0-9hms.\s]+?)(?:\.\s|\.$|$|,)/i.exec(bodyText);
  const bodyWaitMs = parseGroqDurationMs(bodyRetryMatch?.[1]);
  const resetTokensMs = parseGroqDurationMs(readHeader(headers, "x-ratelimit-reset-tokens"));
  const resetRequestsMs = parseGroqDurationMs(readHeader(headers, "x-ratelimit-reset-requests"));

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
export function isContextOverflowResponse(status: number, bodyText: string): boolean {
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

/**
 * Per-model cooldown store backed by Redis (`ratelimit:groq:cooldown:{model}`)
 * with an in-memory fallback so local dev and transient Redis outages fail open cleanly.
 */
export function createCooldownStore(
  db?: GroqCooldownDb | null,
  stage = "pool",
): CooldownStore {
  const memory = new Map<string, CooldownEntry>();

  const resolveDb = (): GroqCooldownDb | undefined => {
    if (db === null) return undefined;
    if (db) return db;
    try {
      return redis() as unknown as GroqCooldownDb;
    } catch (error) {
      logError("groq-cooldown-redis", error, { stage });
      return undefined;
    }
  };

  return {
    async read(models, now) {
      const map = new Map<string, CooldownEntry>();
      if (models.length === 0) return map;

      for (const model of models) {
        const mem = memory.get(model);
        if (mem) {
          if (mem.untilMs > now) map.set(model, mem);
          else memory.delete(model);
        }
      }

      const store = resolveDb();
      if (!store) return map;

      try {
        const pipe = store.pipeline();
        for (const model of models) pipe.get(cooldownKey(model));
        const results = await pipe.exec();
        models.forEach((model, idx) => {
          const decoded = decodeCooldown(results[idx]);
          if (decoded && decoded.untilMs > now) {
            memory.set(model, decoded);
            map.set(model, decoded);
          }
        });
      } catch (error) {
        logError("groq-cooldown-read", error, { models });
      }
      return map;
    },

    async write(model, entry, now, maxTtlSeconds) {
      memory.set(model, entry);
      const store = resolveDb();
      if (!store) return;

      const ttlSeconds = Math.max(
        1,
        Math.min(maxTtlSeconds, Math.ceil((entry.untilMs - now) / 1_000)),
      );
      try {
        await store.set(cooldownKey(model), encodeCooldown(entry), {
          ex: ttlSeconds,
        });
      } catch (error) {
        logError("groq-cooldown-write", error, { model });
      }
    },
  };
}

/**
 * `@ai-sdk/groq` serializes `maxOutputTokens` as OpenAI's deprecated `max_tokens`;
 * normalize it to `max_completion_tokens` as expected by Groq's reasoning models.
 */
export function normalizeGroqCompletionBody(rawBody: string): string {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    return rawBody;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return rawBody;
  }
  if (
    typeof parsed.max_tokens === "number" &&
    parsed.max_completion_tokens === undefined
  ) {
    parsed.max_completion_tokens = parsed.max_tokens;
    delete parsed.max_tokens;
    return JSON.stringify(parsed);
  }
  return rawBody;
}

export function createGroqFetch(baseFetch: GroqFetch = globalThis.fetch): GroqFetch {
  return (input, init) => {
    if (typeof init?.body === "string") {
      return baseFetch(input, {
        ...init,
        body: normalizeGroqCompletionBody(init.body),
      });
    }
    return baseFetch(input, init);
  };
}
