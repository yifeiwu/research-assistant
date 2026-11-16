import "server-only";
import { createAbortError, isAbortError, sleepUntilAborted } from "./errors";
import { logDebug, logError, logInfo } from "./logger";
import { serverConfig } from "./config";
import { normalizeCacheText, requestCache, type RequestCache } from "./cache";

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

export type ExaSearchRequestOptions = {
  maxCharacters?: number;
  highlightsQuery?: string;
};

type RawExaResult = {
  url?: unknown;
  id?: unknown;
  title?: unknown;
  publishedDate?: unknown;
  text?: unknown;
  highlights?: unknown;
};

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
      await sleepUntilAborted(backoffMs(attempt), opts.signal);
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
 * Semantic + keyword web search via Exa REST API, returning neural `highlights`
 * plus bounded lead text in a single HTTP call.
 */
async function searchExa(
  query: string,
  opts: {
    numResults?: number;
    maxCharacters?: number;
    highlightsQuery?: string;
    signal?: AbortSignal;
    requestId?: string;
  } = {},
): Promise<ExaDocument[]> {
  const hlQuery = opts.highlightsQuery?.trim() || query;
  const docs = await postExa(
    "/search",
    {
      query,
      type: "auto",
      numResults: opts.numResults ?? 4,
      contents: {
        highlights: {
          query: hlQuery,
          numSentences: serverConfig.exa.highlightSentences,
          highlightsPerUrl: serverConfig.exa.highlightsPerUrl,
        },
        text: {
          maxCharacters: opts.maxCharacters ?? DEFAULT_MAX_CHARS,
        },
      },
    },
    opts,
  );
  logDebug("exa-search", {
    requestId: opts.requestId,
    query,
    results: docs.length,
  });
  return docs;
}

/**
 * Fetch bounded text + highlights for explicit URLs pasted in the user's query.
 */
async function fetchExaContents(
  urls: string[],
  opts: {
    maxCharacters?: number;
    highlightsQuery?: string;
    signal?: AbortSignal;
    requestId?: string;
  } = {},
): Promise<ExaDocument[]> {
  if (urls.length === 0) return [];
  const hlQuery = opts.highlightsQuery?.trim();
  const docs = await postExa(
    "/contents",
    {
      urls,
      text: {
        maxCharacters: opts.maxCharacters ?? DEFAULT_MAX_CHARS,
      },
      ...(hlQuery
        ? {
            highlights: {
              query: hlQuery,
              numSentences: serverConfig.exa.highlightSentences,
              highlightsPerUrl: serverConfig.exa.highlightsPerUrl,
            },
          }
        : {}),
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
 * Scoped Exa client: Redis request caching and resilient error reporting so
 * individual query or URL failures surface as degraded rather than killing the turn.
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
    const cleanQuery = query.trim();
    const maxChars = reqOpts?.maxCharacters ?? DEFAULT_MAX_CHARS;
    const highlightsQuery = reqOpts?.highlightsQuery?.trim() || undefined;

    try {
      const docs = await cache.wrap(
        "search",
        {
          q: normalizeCacheText(cleanQuery),
          numResults,
          maxChars,
          ...(highlightsQuery ? { hq: normalizeCacheText(highlightsQuery) } : {}),
        },
        serverConfig.cache.searchTtlSeconds,
        () =>
          searchExa(cleanQuery, {
            numResults,
            maxCharacters: maxChars,
            highlightsQuery,
            requestId: opts.requestId,
          }),
        { bypass: opts.disableCache, requestId: opts.requestId, signal: opts.signal },
      );
      return { docs };
    } catch (error) {
      if (isAbortError(error) || opts.signal?.aborted) throw error;
      logError("exa-search", error, { requestId: opts.requestId, query: cleanQuery });
      return { docs: [], error: error instanceof Error ? error.message : "Search failed" };
    }
  };

  const fetchDetailed = async (
    urls: string[],
    reqOpts?: ExaSearchRequestOptions,
  ): Promise<ExaSearchOutcome> => {
    const maxChars = reqOpts?.maxCharacters ?? DEFAULT_MAX_CHARS;
    const highlightsQuery = reqOpts?.highlightsQuery?.trim() || undefined;
    try {
      const docs = await cache.wrap(
        "contents",
        {
          urls: [...urls].sort(),
          maxChars,
          ...(highlightsQuery ? { hq: normalizeCacheText(highlightsQuery) } : {}),
        },
        serverConfig.cache.contentsTtlSeconds,
        () =>
          fetchExaContents(urls, {
            maxCharacters: maxChars,
            highlightsQuery,
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
