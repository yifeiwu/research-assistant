import "server-only";
import { createAbortError, isAbortError, sleepUntilAborted } from "./errors";
import { logDebug, logError, logInfo } from "./logger";
import { serverConfig } from "./config";
import { normalizeCacheText, requestCache, type RequestCache } from "./cache";
import { sharedBucketStore, type BucketStore } from "./agent/token-bucket";

const EXA_API_BASE = "https://api.exa.ai";
const DEFAULT_MAX_CHARS = serverConfig.exa.defaultMaxChars;
const REQUEST_TIMEOUT_MS = serverConfig.exa.timeoutMs;
const MAX_RETRIES = serverConfig.exa.maxRetries;
const BASE_BACKOFF_MS = serverConfig.exa.baseBackoffMs;
const MAX_BACKOFF_MS = serverConfig.exa.maxBackoffMs;

export type ExaDocument = {
  url: string;
  title?: string;
  publishedDate?: string;
  text: string;
  /** Query-relevant passages extracted across the full indexed document by Exa. */
  highlights?: string[];
};

export type ExaSearchType = "auto" | "keyword";

export type ExaSearchRequestOptions = {
  maxCharacters?: number;
  highlightsQuery?: string;
  searchType?: ExaSearchType;
  startPublishedDate?: string;
};

export type StructuredSearchQuery = {
  query: string;
  searchType?: ExaSearchType;
  startPublishedDate?: string;
};

type RawExaResult = {
  url?: unknown;
  id?: unknown;
  title?: unknown;
  publishedDate?: unknown;
  text?: unknown;
  highlights?: unknown;
};

/**
 * Parse optional planner operator prefixes (`RECENT:`, `RECENT[90d]:`, `EXACT:`)
 * into structured Exa search parameters while stripping the prefixes from `query`.
 */
export function parseStructuredSearchQuery(
  rawQuery: string,
  now: Date = new Date(),
): StructuredSearchQuery {
  let rest = rawQuery.trim();
  let searchType: ExaSearchType | undefined;
  let startPublishedDate: string | undefined;

  for (let i = 0; i < 2; i++) {
    const exactMatch = rest.match(/^EXACT\s*:\s*(.+)$/i);
    if (exactMatch) {
      const candidate = exactMatch[1].trim();
      if (candidate) {
        searchType = "keyword";
        rest = candidate;
        continue;
      }
    }

    const recentMatch = rest.match(
      /^RECENT(?:\[(\d+)\s*([dmy])\])?\s*:\s*(.+)$/i,
    );
    if (recentMatch) {
      const candidate = recentMatch[3].trim();
      if (candidate) {
        const amount = recentMatch[1] ? Number.parseInt(recentMatch[1], 10) : 365;
        const unit = (recentMatch[2] ?? "d").toLowerCase();
        const days =
          unit === "y" ? amount * 365 : unit === "m" ? amount * 30 : amount;
        const clampedDays = Math.max(1, Math.min(3_650, days));
        const since = new Date(now.getTime() - clampedDays * 86_400_000);
        startPublishedDate = since.toISOString().slice(0, 10);
        rest = candidate;
        continue;
      }
    }
    break;
  }

  return {
    query: rest || rawQuery.trim(),
    ...(searchType ? { searchType } : {}),
    ...(startPublishedDate ? { startPublishedDate } : {}),
  };
}

function getExaApiKey(): string {
  const apiKey = process.env.EXA_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("EXA_API_KEY environment variable is not set.");
  }
  return apiKey;
}

function backoffMs(attempt: number, response?: Response): number {
  const retryAfter = response?.headers.get("retry-after");
  if (retryAfter) {
    const secs = Number.parseFloat(retryAfter);
    if (Number.isFinite(secs) && secs > 0) {
      return Math.min(MAX_BACKOFF_MS, Math.round(secs * 1000));
    }
  }
  const exp = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** (attempt - 1));
  return Math.round(exp * (0.6 + Math.random() * 0.4));
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  outerSignal?: AbortSignal,
): Promise<Response> {
  if (outerSignal?.aborted) {
    throw createAbortError();
  }

  const controller = new AbortController();
  let timedOut = false;

  const onOuterAbort = () => controller.abort();
  outerSignal?.addEventListener("abort", onOuterAbort, { once: true });

  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (timedOut && !outerSignal?.aborted) {
      throw new Error(`Exa request timed out after ${timeoutMs / 1000}s`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
    outerSignal?.removeEventListener("abort", onOuterAbort);
  }
}

const EXA_RATE_KEY = "ratelimit:exa:rps";

/**
 * Take one slot from the Exa request budget shared across every request and
 * isolate, waiting for it if needed. Returns how long it waited.
 *
 * It only paces: after `maxWaitMs` the call goes ahead anyway, and Exa's own
 * 429 handling (retry with backoff) takes over.
 */
export async function awaitExaRateSlot(opts?: {
  signal?: AbortSignal;
  requestId?: string;
  store?: BucketStore;
  requestsPerSecond?: number;
  burst?: number;
  maxWaitMs?: number;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}): Promise<number> {
  const perSecond = opts?.requestsPerSecond ?? serverConfig.exa.globalRequestsPerSecond;
  if (perSecond <= 0) return 0;
  const maxWaitMs = opts?.maxWaitMs ?? serverConfig.exa.globalMaxWaitMs;
  const store = opts?.store ?? sharedBucketStore();
  const now = opts?.now ?? Date.now;
  const pause = opts?.sleep ?? sleepUntilAborted;
  const bucket = {
    key: EXA_RATE_KEY,
    cost: 1,
    capacity: Math.max(1, opts?.burst ?? serverConfig.exa.globalBurst),
    refillPerMs: perSecond / 1_000,
  };

  const startedAt = now();
  for (;;) {
    if (opts?.signal?.aborted) {
      throw createAbortError();
    }
    const result = await store.reserve([bucket], now());
    const waitedMs = now() - startedAt;
    if (result.granted) return waitedMs;
    if (waitedMs + result.waitMs > maxWaitMs) {
      logInfo("exa-pace-skipped", { requestId: opts?.requestId, waitedMs });
      return waitedMs;
    }
    // Jitter so calls queued together do not all retry on the same tick.
    await pause(result.waitMs + Math.floor(Math.random() * 50), opts?.signal);
  }
}

async function postExa(
  endpoint: "/search" | "/contents",
  payload: Record<string, unknown>,
  opts: { signal?: AbortSignal; requestId?: string },
): Promise<ExaDocument[]> {
  const apiKey = getExaApiKey();
  const url = `${EXA_API_BASE}${endpoint}`;
  const body = JSON.stringify(payload);

  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_RETRIES + 1; attempt++) {
    if (opts.signal?.aborted) {
      throw createAbortError();
    }

    // Every HTTP attempt, retries included, counts against the shared rate.
    await awaitExaRateSlot({ signal: opts.signal, requestId: opts.requestId });

    try {
      const response = await fetchWithTimeout(
        url,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": apiKey,
          },
          body,
        },
        REQUEST_TIMEOUT_MS,
        opts.signal,
      );

      if (response.ok) {
        const json = (await response.json()) as { results?: unknown };
        const rawList = Array.isArray(json.results)
          ? (json.results as RawExaResult[])
          : [];
        return parseExaResults(rawList);
      }

      const retryable = response.status === 429 || response.status >= 500;
      const errText = await response.text().catch(() => "");
      lastError = new Error(
        `Exa ${endpoint} failed with HTTP ${response.status}${
          errText ? `: ${errText.slice(0, 200)}` : ""
        }`,
      );

      if (!retryable || attempt > MAX_RETRIES) {
        throw lastError;
      }

      const waitMs = backoffMs(attempt, response);
      logInfo("exa-retry", {
        requestId: opts.requestId,
        endpoint,
        status: response.status,
        attempt,
        waitMs,
      });
      await sleepUntilAborted(waitMs, opts.signal);
    } catch (error) {
      if (isAbortError(error) || opts.signal?.aborted) {
        throw createAbortError();
      }
      lastError = error;
      if (attempt > MAX_RETRIES) {
        throw error;
      }
      const waitMs = backoffMs(attempt);
      await sleepUntilAborted(waitMs, opts.signal);
    }
  }

  throw lastError instanceof Error ? lastError : new Error("Exa request failed");
}

function parseExaResults(rawList: RawExaResult[]): ExaDocument[] {
  const docs: ExaDocument[] = [];
  for (const item of rawList) {
    if (!item || typeof item !== "object") continue;
    const url =
      typeof item.url === "string" && item.url.trim()
        ? item.url.trim()
        : typeof item.id === "string" && item.id.startsWith("http")
          ? item.id.trim()
          : "";
    if (!url) continue;

    const title =
      typeof item.title === "string" && item.title.trim()
        ? item.title.trim()
        : undefined;
    const publishedDate =
      typeof item.publishedDate === "string" && item.publishedDate.trim()
        ? item.publishedDate.trim()
        : undefined;
    const text = typeof item.text === "string" ? item.text.trim() : "";
    const highlights = Array.isArray(item.highlights)
      ? item.highlights
          .filter((h): h is string => typeof h === "string")
          .map((h) => h.trim())
          .filter(Boolean)
      : undefined;

    docs.push({
      url,
      title,
      publishedDate,
      text,
      ...(highlights && highlights.length > 0 ? { highlights } : {}),
    });
  }
  return docs;
}

/**
 * Semantic + keyword web search via Exa REST API, returning page text (and
 * optional full-document neural highlights) in a single HTTP call.
 */
async function searchExa(
  query: string,
  opts: {
    numResults?: number;
    maxCharacters?: number;
    highlightsQuery?: string;
    searchType?: ExaSearchType;
    startPublishedDate?: string;
    signal?: AbortSignal;
    requestId?: string;
  } = {},
): Promise<ExaDocument[]> {
  const highlightsQuery = opts.highlightsQuery?.trim();
  const docs = await postExa(
    "/search",
    {
      query,
      type: opts.searchType ?? "auto",
      numResults: opts.numResults ?? 4,
      ...(opts.startPublishedDate
        ? { startPublishedDate: opts.startPublishedDate }
        : {}),
      contents: {
        text: {
          maxCharacters: opts.maxCharacters ?? DEFAULT_MAX_CHARS,
        },
        ...(highlightsQuery
          ? {
              highlights: {
                query: highlightsQuery,
                numSentences: serverConfig.exa.highlightSentences,
                highlightsPerUrl: serverConfig.exa.highlightsPerUrl,
              },
            }
          : {}),
      },
    },
    opts,
  );
  logDebug("exa-search", {
    requestId: opts.requestId,
    query,
    type: opts.searchType ?? "auto",
    results: docs.length,
  });
  return docs;
}

/**
 * Fetch full text content for explicit URLs (e.g. URLs pasted directly in the
 * user's message) via Exa's `/contents` endpoint.
 */
async function fetchExaContents(
  urls: string[],
  opts: {
    maxCharacters?: number;
    signal?: AbortSignal;
    requestId?: string;
  } = {},
): Promise<ExaDocument[]> {
  if (urls.length === 0) return [];
  const docs = await postExa(
    "/contents",
    {
      urls,
      text: {
        maxCharacters: opts.maxCharacters ?? DEFAULT_MAX_CHARS,
      },
    },
    opts,
  );
  logDebug("exa-contents", {
    requestId: opts.requestId,
    urls: urls.length,
    results: docs.length,
  });
  return docs;
}

export type ExaSearchOutcome = { docs: ExaDocument[]; error?: string };

/**
 * Scoped Exa client (the SearchProvider adapter): Redis request caching and
 * resilient error reporting so individual query or URL failures don't kill a
 * turn while still being surfaced as degraded.
 */
export function createExaClient(opts: {
  signal?: AbortSignal;
  requestId?: string;
  cache?: RequestCache;
  disableCache?: boolean;
} = {}) {
  const cache = opts.cache ?? requestCache;

  const searchDetailed = async (
    query: string,
    numResults: number,
    reqOpts?: ExaSearchRequestOptions,
  ): Promise<ExaSearchOutcome> => {
    const structured = parseStructuredSearchQuery(query);
    const effectiveQuery = structured.query;
    const maxChars = reqOpts?.maxCharacters ?? DEFAULT_MAX_CHARS;
    const searchType = reqOpts?.searchType ?? structured.searchType;
    const startPublishedDate =
      reqOpts?.startPublishedDate ?? structured.startPublishedDate;
    const highlightsQuery = reqOpts?.highlightsQuery?.trim() || undefined;

    try {
      const docs = await cache.wrap(
        "search",
        {
          q: normalizeCacheText(effectiveQuery),
          numResults,
          maxChars,
          ...(searchType && searchType !== "auto" ? { type: searchType } : {}),
          ...(startPublishedDate ? { since: startPublishedDate } : {}),
          ...(highlightsQuery ? { hq: normalizeCacheText(highlightsQuery) } : {}),
        },
        serverConfig.cache.searchTtlSeconds,
        // Signal-free loader: this task may be coalesced across callers, so
        // one caller's abort must not fail the rest. Our own signal is passed
        // to `wrap`, which detaches only this caller.
        () =>
          searchExa(effectiveQuery, {
            numResults,
            maxCharacters: maxChars,
            highlightsQuery,
            searchType,
            startPublishedDate,
            requestId: opts.requestId,
          }),
        { bypass: opts.disableCache, requestId: opts.requestId, signal: opts.signal },
      );
      return { docs };
    } catch (error) {
      if (isAbortError(error) || opts.signal?.aborted) throw error;
      logError("exa-search", error, { requestId: opts.requestId, query: effectiveQuery });
      return { docs: [], error: error instanceof Error ? error.message : "Search failed" };
    }
  };

  const fetchDetailed = async (
    urls: string[],
    reqOpts?: { maxCharacters?: number },
  ): Promise<ExaSearchOutcome> => {
    const maxChars = reqOpts?.maxCharacters ?? DEFAULT_MAX_CHARS;
    try {
      // Explicitly pasted URLs use the short contents TTL: the user may have
      // just changed the page, so long-lived caching would serve stale text.
      const docs = await cache.wrap(
        "contents",
        { urls: [...urls].sort(), maxChars },
        serverConfig.cache.contentsTtlSeconds,
        () =>
          fetchExaContents(urls, {
            maxCharacters: maxChars,
            requestId: opts.requestId,
          }),
        { bypass: opts.disableCache, requestId: opts.requestId, signal: opts.signal },
      );
      return { docs };
    } catch (error) {
      if (isAbortError(error) || opts.signal?.aborted) throw error;
      logError("exa-contents", error, { requestId: opts.requestId, urls });
      return { docs: [], error: error instanceof Error ? error.message : "Contents fetch failed" };
    }
  };

  return { searchDetailed, fetchDetailed };
}
