/** True for the standard cancellation error (`AbortController` / fetch /
 * AI SDK aborts surface as an `Error` named `"AbortError"`). */
export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
