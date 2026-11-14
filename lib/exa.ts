import "server-only";
import { logDebug, logError, logInfo } from "./logger";

const EXA_API_BASE = "https://api.exa.ai";
const DEFAULT_MAX_CHARS = 14_000;
const REQUEST_TIMEOUT_MS = 25_000;
const MAX_RETRIES = 2;
const BASE_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 3_000;

/**
 * Per-request Exa concurrency cap. With Exa's 10 req/s global limit and up to
 * 2 concurrent users, 4 concurrent calls per user keeps peak burst at <= 8 req/s.
 */
export const EXA_CONCURRENCY_PER_REQUEST = 4;

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
export function createConcurrencyLimiter(
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

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
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
export async function searchExa(
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
export async function fetchExaContents(
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
export function createExaClient(opts: {
  maxConcurrent?: number;
  signal?: AbortSignal;
  requestId?: string;
}) {
  const limit = createConcurrencyLimiter(
    opts.maxConcurrent ?? EXA_CONCURRENCY_PER_REQUEST,
  );

  return {
    search: (query: string, numResults: number) =>
      limit(async () => {
        try {
          return await searchExa(query, {
            numResults,
            signal: opts.signal,
            requestId: opts.requestId,
          });
        } catch (error) {
          if (isAbortError(error) || opts.signal?.aborted) throw error;
          logError("exa-search", error, { requestId: opts.requestId, query });
          return [];
        }
      }),
    fetchContents: (urls: string[]) =>
      limit(async () => {
        try {
          return await fetchExaContents(urls, {
            signal: opts.signal,
            requestId: opts.requestId,
          });
        } catch (error) {
          if (isAbortError(error) || opts.signal?.aborted) throw error;
          logError("exa-contents", error, {
            requestId: opts.requestId,
            urls,
          });
          return [];
        }
      }),
  };
}
