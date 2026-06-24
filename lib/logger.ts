import { APICallError } from "ai";

const PREFIX = "[research-assistant]";

/** Verbose per-step logging is on outside production, or when DEBUG_AGENT=1. */
export const DEBUG =
  process.env.DEBUG_AGENT === "1" || process.env.NODE_ENV !== "production";

function truncate(value: string | undefined, max = 4000): string | undefined {
  if (value == null) return undefined;
  return value.length > max ? `${value.slice(0, max)}… [truncated]` : value;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Pull Groq's `failed_generation` (the raw text the model produced that could
 * not be parsed into a valid tool call) out of an API error, if present.
 */
export function extractFailedGeneration(error: unknown): string | undefined {
  if (!APICallError.isInstance(error)) return undefined;
  try {
    const parsed: unknown =
      error.data ??
      (error.responseBody ? JSON.parse(error.responseBody) : undefined);
    const root = parsed as
      | { failed_generation?: unknown; error?: { failed_generation?: unknown } }
      | undefined;
    const fg = root?.error?.failed_generation ?? root?.failed_generation;
    return typeof fg === "string" ? truncate(fg) : undefined;
  } catch {
    return undefined;
  }
}

/** Build a structured, log-friendly description of any error. */
export function describeError(error: unknown): Record<string, unknown> {
  if (APICallError.isInstance(error)) {
    return {
      kind: "APICallError",
      name: error.name,
      message: error.message,
      statusCode: error.statusCode,
      url: error.url,
      isRetryable: error.isRetryable,
      failedGeneration: extractFailedGeneration(error),
      responseBody: truncate(error.responseBody),
    };
  }
  if (error instanceof Error) {
    return {
      kind: error.name,
      message: error.message,
      stack: error.stack,
    };
  }
  return { kind: "unknown", value: safeStringify(error) };
}

export function logInfo(scope: string, data: Record<string, unknown>): void {
  console.log(`${PREFIX} ${scope}`, safeStringify(data));
}

export function logDebug(scope: string, data: Record<string, unknown>): void {
  if (!DEBUG) return;
  console.log(`${PREFIX} [debug] ${scope}`, safeStringify(data));
}

export function logError(
  scope: string,
  error: unknown,
  extra?: Record<string, unknown>,
): void {
  console.error(
    `${PREFIX} ${scope}`,
    JSON.stringify({ ...describeError(error), ...extra }, null, 2),
  );
}
