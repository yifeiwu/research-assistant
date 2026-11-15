/**
 * Longest `Retry-After` the client will sit out on its own. Longer waits
 * (e.g. the hourly per-visitor limit) are surfaced as an error instead.
 */
const MAX_AUTO_RETRY_AFTER_SECONDS = 20;

/** `Retry-After` in whole seconds, or null if absent or not a delay. */
function retryAfterSeconds(response: Response): number | null {
  const raw = response.headers.get("retry-after")?.trim();
  if (!raw || !/^\d+(\.\d+)?$/.test(raw)) return null;
  return Math.ceil(Number(raw));
}

function abortableDelay(ms: number, signal?: AbortSignal | null): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () =>
      reject(signal?.reason ?? new DOMException("The operation was aborted.", "AbortError"));
    if (signal?.aborted) {
      abort();
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      abort();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * `fetch`, but a 429 that asks for a short wait is retried once after that
 * wait instead of being returned. The server uses such a 429 as back-pressure
 * (too many messages in a minute, or a full research queue), so a brief pause
 * usually succeeds where an error would just make the user click Retry.
 *
 * Rejects like `fetch` does if `init.signal` aborts during the wait.
 */
export async function fetchWithRetryAfter(
  fetchImpl: typeof fetch,
  input: RequestInfo | URL,
  init?: RequestInit,
  opts?: {
    maxWaitSeconds?: number;
    delay?: (ms: number, signal?: AbortSignal | null) => Promise<void>;
  },
): Promise<Response> {
  const response = await fetchImpl(input, init);
  if (response.status !== 429) return response;

  // Only replay requests whose body can be sent again.
  const replayable =
    !(input instanceof Request) && (init?.body == null || typeof init.body === "string");
  const seconds = retryAfterSeconds(response);
  const maxWait = opts?.maxWaitSeconds ?? MAX_AUTO_RETRY_AFTER_SECONDS;
  if (!replayable || seconds === null || seconds > maxWait) return response;

  void response.body?.cancel().catch(() => {});
  await (opts?.delay ?? abortableDelay)(seconds * 1_000, init?.signal);
  return fetchImpl(input, init);
}
