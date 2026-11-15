/** JSON.stringify that never throws (e.g. on circular refs), for logging. */
export function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Decode a value read from Redis / Upstash: Upstash auto-deserializes JSON
 * objects/arrays on read, while plain strings or test doubles may return raw
 * JSON text.
 */
export function decodeStoredJson<T>(raw: unknown): T | null {
  if (raw == null) return null;
  if (typeof raw !== "string") return raw as T;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}
