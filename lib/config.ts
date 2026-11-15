import "server-only";

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

/** Single home for server-side tunables (timeouts, caps, cache TTLs). */
export const serverConfig = {
  groqModel: process.env.GROQ_MODEL ?? "openai/gpt-oss-120b",
  // Dedicated fast model for query planning and gap checks so auxiliary
  // stages use their own Groq TPM bucket instead of starving `groqModel`.
  plannerModel: "openai/gpt-oss-20b",
  // Hardcoded summarizer model (no env override): verified against Groq's
  // model list — `qwen/qwen3.8-27b` is the current Qwen 27B on Groq. Its
  // predecessor `qwen/qwen3.6-27b` was deprecated 2026-09-14 and
  // `llama-3.1-8b-instant` was shut down 2026-08-16, so a stale env default
  // silently degraded every research turn to raw-text fallbacks.
  summaryModel: "qwen/qwen3.8-27b",
  // The fixed shape of a research round. Effort (lib/effort.ts) only changes
  // how many rounds run and how many follow-up queries a gap check may add.
  research: {
    // Searches planned for the first round.
    initialQueries: 2,
    resultsPerQuery: 4,
    // Unique sources condensed per round, and in total across all rounds.
    sourcesPerRound: 4,
    maxSources: 14,
  },
  exa: {
    timeoutMs: intFromEnv("EXA_TIMEOUT_MS", 25_000),
    maxRetries: 2,
    baseBackoffMs: 500,
    maxBackoffMs: 3_000,
    // Exa calls in flight at once for one conversation thread.
    concurrencyPerThread: 2,
    defaultMaxChars: 14_000,
    // Shared (Redis) cap on the sustained rate of Exa HTTP calls across every
    // request and isolate. 0 disables it. A short burst of `globalBurst`
    // calls may go out on top, so the defaults peak at Exa's 10 req/s limit.
    globalRequestsPerSecond: nonNegativeIntFromEnv("EXA_REQUESTS_PER_SECOND", 8),
    globalBurst: 2,
    // Longest a single Exa call queues for the shared cap before going anyway.
    globalMaxWaitMs: 5_000,
  },
  summary: {
    passthroughCharLimit: 1_500,
    // All sources in a round are condensed in ONE batched model call (see
    // lib/pipeline.ts). The batch input is capped so sequential rounds'
    // batches fit inside the summary model's per-minute input-token limit
    // (7k ITPM on the current Groq org): at a 20k-char cap production
    // batches requested 3.7-4.2k input tokens each, so round 2 always
    // busted the window. Halving the cap puts a batch at ~2k tokens, so
    // 2-3 rounds fit in one minute. Each source still gets a bounded slice
    // so one long page cannot starve the rest.
    batchInputCharCap: 10_000,
    perSourceInputCharCap: 3_000,
    fallbackCharCap: 4_000,
    // Groq reserves the full max-output budget against the summary model's
    // OTPM. `maxSummaryOutputTokens` caps Qwen 3.8 27B at 450 (so 2 rounds
    // = 900 <= 1,000 OTPM), while GPT-OSS models without a 1k OTPM cap get
    // 650 tokens to accommodate "low" reasoning + dense factual bullets.
    batchMaxOutputTokens: 650,
    timeoutMs: 25_000,
  },
  // Planner/gap-check outputs are a handful of short query lines (or DONE /
  // NO_SEARCH); with auxiliary reasoning set to "low"/"none" and routed to a
  // separate planner model, output reservations stay compact.
  planner: { timeoutMs: 30_000, maxOutputTokens: 300 },
  gapCheck: { timeoutMs: 25_000, maxOutputTokens: 250, notesTokenBudget: 1_000 },
  synthesis: {
    // Upper bounds. An answer also has to be over before its invocation is
    // (see `detached.invocationLimitMs`), so it gets the smaller of these
    // and the time that is left.
    totalTimeoutMs: 180_000,
    stepTimeoutMs: 120_000,
    // With less time than this left in the invocation, the answer is not
    // started there at all: the turn is handed over instead.
    minWindowMs: 30_000,
    // Output cap includes reasoning tokens (gpt-oss spent ~700 of the old
    // 2,500 cap on reasoning in production, truncating answers mid-table
    // with finishReason "length"). 3,500 leaves room for both while still
    // fitting the 8k TPM window: evidence-capped input is ~2.9k tokens.
    maxOutputTokens: 3_500,
    // Cap on the assembled research-notes evidence injected into synthesis.
    // Groq's free tier rejects requests over ~8k TPM in one shot (observed
    // 413s in production), so the evidence is trimmed to fit, leaving room
    // for history, the system prompt, and the answer itself.
    evidenceTokenBudget: intFromEnv("SYNTHESIS_EVIDENCE_TOKEN_BUDGET", 3_000),
  },
  groqRateLimit: {
    // Reactive waits inside the fetch wrapper after an unexpected 429. These
    // run inside the AI SDK call (so they count against its timeout) and stay
    // short; planned waiting happens in the scheduler below instead.
    synthesisMaxWaitMs: intFromEnv("GROQ_SYNTHESIS_MAX_WAIT_MS", 10_000),
    plannerMaxWaitMs: intFromEnv("GROQ_PLANNER_MAX_WAIT_MS", 3_000),
    summaryMaxWaitMs: 0,
    maxCooldownSeconds: 300,
    // Longest a stage waits (visibly) for its model's per-minute window
    // (lib/agent/scheduler.ts) before switching model or degrading. Waits
    // happen before the AI SDK call, so they do not eat into the model-call
    // timeouts above.
    budgetWait: {
      synthesisMs: 25_000,
      plannerMs: 10_000,
      summaryMs: 20_000,
    },
    // TPM an auxiliary stage must leave free in a *fallback* model's bucket,
    // so one turn's planner/summariser cannot drain another turn's answer.
    synthesisReserveTokens: 4_000,
  },
  admission: {
    // Research turns (effort with web rounds) running at once across all
    // instances; the rest queue FIFO with a visible position. 0 disables.
    maxConcurrentTurns: nonNegativeIntFromEnv("MAX_CONCURRENT_RESEARCH_TURNS", 2),
    // Beyond this many queued turns the route answers 429 + Retry-After.
    maxQueueLength: intFromEnv("MAX_QUEUED_RESEARCH_TURNS", 20),
    maxQueueWaitMs: intFromEnv("MAX_RESEARCH_QUEUE_WAIT_MS", 120_000),
    // A running turn's slot expires unless its attempt keeps renewing it, and
    // a queued turn's ticket unless it is polled again, so a turn that dies
    // frees its place. `ticketTtlMs` has to comfortably outlast the gap
    // between two polls (`detached.queuePollDelayMs`).
    leaseMs: 30_000,
    ticketTtlMs: 20_000,
  },
  // A turn is saved as a job in Redis and run in attempts by the requests
  // that tail it (see lib/agent/detached.ts).
  detached: {
    jobTtlSeconds: 30 * 60,
    // Pipeline attempts per turn (first run + retries after a crash/defer).
    maxAttempts: 4,
    // How long a turn that is still in the research queue waits before it
    // looks again. Each look costs a handful of Redis commands, so a
    // shorter delay admits a turn sooner after a slot frees at that price.
    queuePollDelayMs: 3_000,
    // The claim of the invocation driving a run, renewed about once a
    // second while it streams. Once it lapses the invocation is taken to
    // have died, and the next request that tails the run takes it over.
    runLeaseSeconds: 12,
    // In-process retries of an attempt that threw, 5s, 10s and 15s apart.
    // After the last one the turn ends with an error.
    retries: 3,
    retryDelayMs: 5_000,
    // Longest rate-limit wait a turn defers for instead of answering degraded.
    maxDeferMs: 90_000,
    // How long an invocation may run: the routes' `maxDuration`, in ms. They
    // have to agree, which tests/config.test.ts checks.
    invocationLimitMs: 300_000,
    // Kept back at the end of an invocation for closing the run in Redis
    // once the answer's stream has ended.
    finishMarginMs: 10_000,
    // An invocation older than this starts nothing long: no wait, no new
    // attempt and no answer. It hands the run over to the next request that
    // tails it. An answer started just before this point may still wait up
    // to `budgetWait.synthesisMs` for its model, and then streams with what
    // is left of the invocation as its timeout.
    handoffAfterMs: 150_000,
    // How often a request tailing a run driven elsewhere checks that the
    // driver is still alive.
    watchIntervalMs: 5_000,
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
