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
  // Hardcoded summarizer model (no env override): verified against Groq's
  // model list — `qwen/qwen3.8-27b` is the current Qwen 27B on Groq. Its
  // predecessor `qwen/qwen3.6-27b` was deprecated 2026-09-14 and
  // `llama-3.1-8b-instant` was shut down 2026-08-16, so a stale env default
  // silently degraded every research turn to raw-text fallbacks.
  summaryModel: "qwen/qwen3.8-27b",
  exa: {
    timeoutMs: intFromEnv("EXA_TIMEOUT_MS", 25_000),
    maxRetries: 2,
    baseBackoffMs: 500,
    maxBackoffMs: 3_000,
    concurrencyPerRequest: intFromEnv("EXA_CONCURRENCY_PER_REQUEST", 2),
    defaultMaxChars: 14_000,
  },
  summary: {
    passthroughCharLimit: 1_500,
    // All sources in a round are condensed in ONE batched model call (see
    // lib/pipeline.ts). The batch input is capped so a single request stays
    // under the summary model's per-minute input-token limit (7k ITPM on the
    // current Groq org) once the system prompt is added, and each source
    // gets a bounded slice so one long page cannot starve the rest.
    batchInputCharCap: 20_000,
    perSourceInputCharCap: 6_000,
    fallbackCharCap: 4_000,
    batchMaxOutputTokens: 900,
    timeoutMs: 25_000,
  },
  planner: { timeoutMs: 30_000, maxOutputTokens: 1_500 },
  gapCheck: { timeoutMs: 25_000, maxOutputTokens: 1_500 },
  synthesis: {
    totalTimeoutMs: 180_000,
    stepTimeoutMs: 120_000,
    // Cap on the assembled research-notes evidence injected into synthesis.
    // Groq's free tier rejects requests over ~8k TPM in one shot (observed
    // 413s in production), so the evidence is trimmed to fit, leaving room
    // for history, the system prompt, and the answer itself.
    evidenceTokenBudget: intFromEnv("SYNTHESIS_EVIDENCE_TOKEN_BUDGET", 3_000),
  },
  rateLimit: {
    // Per-IP fixed windows for POST /api/chat (checked in Redis).
    perMinute: intFromEnv("RATE_LIMIT_PER_MINUTE", 6),
    perHour: intFromEnv("RATE_LIMIT_PER_HOUR", 60),
  },
  cache: {
    searchTtlSeconds: intFromEnv("CACHE_SEARCH_TTL_SECONDS", 900),
    notesTtlSeconds: intFromEnv("CACHE_NOTES_TTL_SECONDS", 86_400),
    contentsTtlSeconds: intFromEnv("CACHE_CONTENTS_TTL_SECONDS", 900),
  },
} as const;
