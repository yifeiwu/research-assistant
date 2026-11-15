/** True for the standard cancellation error (`AbortController` / fetch /
 * AI SDK aborts surface as an `Error` named `"AbortError"`). */
export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

export function createAbortError(): DOMException {
  return new DOMException("The operation was aborted.", "AbortError");
}

/**
 * Sleep for `ms`, resolving early (without throwing) as soon as `signal` aborts.
 */
export function sleepUntilAborted(
  ms: number,
  signal?: AbortSignal | null,
): Promise<void> {
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

/**
 * Abort-aware sleep that rejects with `AbortError` (or `signal.reason`)
 * immediately if `signal` is already aborted or aborts during the wait.
 */
export function abortableSleep(
  ms: number,
  signal?: AbortSignal | null,
  sleepImpl?: (ms: number) => Promise<void>,
): Promise<void> {
  const rejectReason = () =>
    signal?.reason instanceof Error ? signal.reason : createAbortError();

  if (signal?.aborted) {
    return Promise.reject(rejectReason());
  }
  if (ms <= 0) return Promise.resolve();

  if (sleepImpl) {
    return new Promise<void>((resolve, reject) => {
      const onAbort = () => reject(rejectReason());
      signal?.addEventListener("abort", onAbort, { once: true });
      sleepImpl(ms).then(
        () => {
          signal?.removeEventListener("abort", onAbort);
          if (signal?.aborted) {
            reject(rejectReason());
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
      reject(rejectReason());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
