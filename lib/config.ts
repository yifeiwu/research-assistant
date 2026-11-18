import "server-only";
import { REASONING_POOL, SUMMARIZER_POOL } from "./models";

function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Like `intFromEnv`, but `0` is a meaningful value (it disables the feature). */
function nonNegativeIntFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function listFromEnv(name: string, fallback: readonly string[]): string[] {
  const raw = process.env[name];
  if (!raw) return [...fallback];
  const items = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return items.length > 0 ? items : [...fallback];
}

/** Single home for server-side tunables (timeouts, caps, cache TTLs). */
export const serverConfig = {
  // Fungible Groq quota pools (override via comma-separated model IDs):
  // - `reasoningPool`: synthesis, query planning, and gap checks.
  // - `summarizerPool`: smaller free-tier models dedicated to source condensation.
  reasoningPool: listFromEnv("GROQ_REASONING_POOL", REASONING_POOL),
  summarizerPool: listFromEnv("GROQ_SUMMARIZER_POOL", SUMMARIZER_POOL),
  research: {
    resultsPerQuery: 6,
    deepResultsPerQuery: 8,
    sourcesPerRound: 4,
    deepSourcesPerRound: 6,
    maxSources: 20,
  },
  exa: {
    timeoutMs: intFromEnv("EXA_TIMEOUT_MS", 25_000),
    maxRetries: 2,
    baseBackoffMs: 500,
    maxBackoffMs: 3_000,
    defaultMaxChars: 4_000,
    highlightsPerUrl: 5,
    highlightSentences: 4,
  },
  summary: {
    passthroughCharLimit: 1_500,
    batchInputCharCap: 10_000,
    perSourceInputCharCap: 3_000,
    deepPerSourceInputCharCap: 4_000,
    batchSize: 2,
    deepBatchSize: 2,
    fallbackCharCap: 2_500,
    batchMaxOutputTokens: 1_000,
    timeoutMs: 25_000,
  },
  planner: { timeoutMs: 30_000, maxOutputTokens: 600 },
  gapCheck: { timeoutMs: 25_000, maxOutputTokens: 400, notesTokenBudget: 1_000 },
  synthesis: {
    totalTimeoutMs: 180_000,
    maxOutputTokens: 4_000,
    historyTokenBudget: 1_400,
    evidenceTokenBudget: intFromEnv("SYNTHESIS_EVIDENCE_TOKEN_BUDGET", 2_800),
    deepEvidenceTokenBudget: 3_200,
  },
  groqRateLimit: {
    // Smooth rate control: book up to 88% of nominal free-tier TPM/ITPM/OTPM
    // (absorbing tokenizer variance) and pace consecutive calls on the same
    // model once its rolling window drops below 70% remaining.
    budgetUtilizationCap: 0.88,
    paceBelowRatio: 0.7,
    paceRatio: 0.45,
    // Prefer waiting on each stage's dedicated pool before borrowing across pools
    // so summarization doesn't raid reasoning quota needed for synthesis.
    preferPoolWaitMs: {
      synthesis: 30_000,
      planner: 20_000,
      summary: 25_000,
    },
    stageMaxWaitMs: {
      synthesis: intFromEnv("GROQ_SYNTHESIS_MAX_WAIT_MS", 150_000),
      planner: intFromEnv("GROQ_PLANNER_MAX_WAIT_MS", 90_000),
      summary: intFromEnv("GROQ_SUMMARY_MAX_WAIT_MS", 90_000),
    },
    synthesisReserveTokens: 4_000,
    // Per-HTTP-attempt network timeouts (decoupled from rate-limit wait sleeps).
    attemptTimeoutMs: {
      synthesis: 120_000,
      planner: 30_000,
      summary: 30_000,
    },
    maxCooldownSeconds: 300,
    retiredModelTtlSeconds: 24 * 60 * 60,
  },
  queue: {
    // FIFO concurrency cap across instances so simultaneous turns wait in line
    // instead of exhausting the shared model pools at once. `0` disables.
    maxConcurrentTurns: nonNegativeIntFromEnv("MAX_CONCURRENT_TURNS", 2),
    maxQueueLength: intFromEnv("MAX_QUEUE_LENGTH", 20),
    maxWaitMs: intFromEnv("MAX_QUEUE_WAIT_MS", 180_000),
    pollMs: 2_000,
    leaseMs: 30_000,
  },
  turn: {
    ttlSeconds: 30 * 60,
    heartbeatMs: 3_000,
    staleMs: 60_000,
    invocationLimitMs: 300_000,
    finishMarginMs: 15_000,
  },
  rateLimit: {
    perMinute: intFromEnv("RATE_LIMIT_PER_MINUTE", 6),
    perHour: nonNegativeIntFromEnv("RATE_LIMIT_PER_HOUR", 60),
  },
  cache: {
    searchTtlSeconds: intFromEnv("CACHE_SEARCH_TTL_SECONDS", 900),
    notesTtlSeconds: intFromEnv("CACHE_NOTES_TTL_SECONDS", 86_400),
    contentsTtlSeconds: intFromEnv("CACHE_CONTENTS_TTL_SECONDS", 900),
  },
} as const;
