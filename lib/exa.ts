import "server-only";
import { isAbortError } from "./errors";
import { logDebug, logError, logInfo } from "./logger";
import { serverConfig } from "./config";
import { normalizeCacheText, requestCache, type RequestCache } from "./cache";

const EXA_API_BASE = "https://api.exa.ai";
const DEFAULT_MAX_CHARS = serverConfig.exa.defaultMaxChars;
const REQUEST_TIMEOUT_MS = serverConfig.exa.timeoutMs;
const MAX_RETRIES = serverConfig.exa.maxRetries;
const BASE_BACKOFF_MS = serverConfig.exa.baseBackoffMs;
const MAX_BACKOFF_MS = serverConfig.exa.maxBackoffMs;

/**
 * Per-request Exa concurrency cap. Research rounds run at most 2 queries, so
 * 2 concurrent calls per request keeps a single request's burst low against
 * Exa's 10 req/s global limit even with several concurrent users.
 */
const EXA_CONCURRENCY_PER_REQUEST =
  serverConfig.exa.concurrencyPerRequest;

export type ExaDocument = {
  url: string;
  title?: string;
  publishedDate?: string;
  text: string;
};

type RawExaResult = {
  url?: unknown;
  id?: unknown;
  title?: unknown;
  publishedDate?: unknown;
  text?: unknown;
};

/** Bound async work to at most `limit` in-flight promises at once. */
function createConcurrencyLimiter(
  limit: number,
): <T>(fn: () => Promise<T>) => Promise<T> {
  const cap = Math.max(1, Math.floor(limit));
  let active = 0;
  const queue: Array<() => void> = [];

  const next = () => {
    active -= 1;
    const wake = queue.shift();
    if (wake) wake();
  };

  return <T>(fn: () => Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const run = () => {
        active += 1;
        fn().then(
          (val) => {
            next();
            resolve(val);
          },
          (err) => {
            next();
            reject(err);
          },
        );
      };

      if (active < cap) {
        run();
      } else {
        queue.push(run);
      }
    });
}

function getExaApiKey(): string {
  const apiKey = process.env.EXA_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("EXA_API_KEY environment variable is not set.");
  }
  return apiKey;
}


function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0 || signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
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
    throw new DOMException("The operation was aborted.", "AbortError");
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
      throw new DOMException("The operation was aborted.", "AbortError");
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
      await sleep(waitMs, opts.signal);
    } catch (error) {
      if (isAbortError(error) || opts.signal?.aborted) {
        throw new DOMException("The operation was aborted.", "AbortError");
      }
      lastError = error;
      if (attempt > MAX_RETRIES) {
        throw error;
      }
      const waitMs = backoffMs(attempt);
      await sleep(waitMs, opts.signal);
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

    docs.push({ url, title, publishedDate, text });
  }
  return docs;
}

/**
 * Semantic + keyword web search via Exa REST API, returning page text in a
 * single HTTP call (no separate crawl step needed).
 */
async function searchExa(
  query: string,
  opts: {
    numResults?: number;
    maxCharacters?: number;
    signal?: AbortSignal;
    requestId?: string;
  } = {},
): Promise<ExaDocument[]> {
  const docs = await postExa(
    "/search",
    {
      query,
      type: "auto",
      numResults: opts.numResults ?? 4,
      contents: {
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

/**
 * Scoped Exa client enforcing a per-request concurrency cap (`maxConcurrent`)
 * and resilient error handling so individual query failures don't kill a round.
 */
export type ExaSearchOutcome = { docs: ExaDocument[]; error?: string };

/**
 * Scoped Exa client (the SearchProvider adapter) enforcing a per-request
 * concurrency cap, Redis request caching, and resilient error reporting so
 * individual query failures don't kill a round — but are no longer silent.
 */
export function createExaClient(opts: {
  maxConcurrent?: number;
  signal?: AbortSignal;
  requestId?: string;
  cache?: RequestCache;
  disableCache?: boolean;
}) {
  const limit = createConcurrencyLimiter(
    opts.maxConcurrent ?? EXA_CONCURRENCY_PER_REQUEST,
  );
  const cache = opts.cache ?? requestCache;

  const searchDetailed = async (
    query: string,
    numResults: number,
  ): Promise<ExaSearchOutcome> => {
    try {
      const docs = await cache.wrap(
        "search",
        {
          q: normalizeCacheText(query),
          numResults,
          maxChars: DEFAULT_MAX_CHARS,
        },
        serverConfig.cache.searchTtlSeconds,
        // Signal-free loader: this task may be coalesced across callers, so
        // one caller's abort must not fail the rest. Our own signal is passed
        // to `wrap`, which detaches only this caller.
        () =>
          searchExa(query, {
            numResults,
            requestId: opts.requestId,
          }),
        { bypass: opts.disableCache, requestId: opts.requestId, signal: opts.signal },
      );
      return { docs };
    } catch (error) {
      if (isAbortError(error) || opts.signal?.aborted) throw error;
      logError("exa-search", error, { requestId: opts.requestId, query });
      return { docs: [], error: error instanceof Error ? error.message : "Search failed" };
    }
  };

  const fetchDetailed = async (urls: string[]): Promise<ExaSearchOutcome> => {
    try {
      // Explicitly pasted URLs use the short contents TTL: the user may have
      // just changed the page, so long-lived caching would serve stale text.
      const docs = await cache.wrap(
        "contents",
        { urls: [...urls].sort(), maxChars: DEFAULT_MAX_CHARS },
        serverConfig.cache.contentsTtlSeconds,
        () =>
          fetchExaContents(urls, {
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

  return {
    searchDetailed: (query: string, numResults: number) =>
      limit(() => searchDetailed(query, numResults)),
    fetchDetailed: (urls: string[]) => limit(() => fetchDetailed(urls)),
  };
}
