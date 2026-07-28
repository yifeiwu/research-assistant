/** JSON.stringify that never throws (e.g. on circular refs), for logging. */
export function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
