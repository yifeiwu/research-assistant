import "server-only";

function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Single home for server-side tunables (timeouts, caps, cache TTLs). */
export const serverConfig = {
  groqModel: process.env.GROQ_MODEL ?? "openai/gpt-oss-120b",
  summaryModel: process.env.GROQ_SUMMARY_MODEL ?? "llama-3.1-8b-instant",
  exa: {
    timeoutMs: intFromEnv("EXA_TIMEOUT_MS", 25_000),
    maxRetries: 2,
    baseBackoffMs: 500,
    maxBackoffMs: 3_000,
    concurrencyPerRequest: intFromEnv("EXA_CONCURRENCY_PER_REQUEST", 4),
    defaultMaxChars: 14_000,
  },
  summary: {
    passthroughCharLimit: 1_500,
    inputCharCap: 16_000,
    fallbackCharCap: 4_000,
    concurrency: 4,
    maxOutputTokens: 700,
    timeoutMs: 25_000,
  },
  planner: { timeoutMs: 30_000, maxOutputTokens: 1_500 },
  gapCheck: { timeoutMs: 25_000, maxOutputTokens: 1_500 },
  synthesis: { totalTimeoutMs: 180_000, stepTimeoutMs: 120_000 },
  cache: {
    searchTtlSeconds: intFromEnv("CACHE_SEARCH_TTL_SECONDS", 900),
    notesTtlSeconds: intFromEnv("CACHE_NOTES_TTL_SECONDS", 86_400),
    contentsTtlSeconds: intFromEnv("CACHE_CONTENTS_TTL_SECONDS", 900),
  },
} as const;
