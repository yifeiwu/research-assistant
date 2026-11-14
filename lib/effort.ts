/**
 * Research "effort" controls how deeply the deterministic research pipeline
 * searches and condenses sources before synthesizing an answer.
 *
 * Tuned for Exa's 10 req/s global rate limit assuming at most 2 concurrent
 * users: each request runs at most 4 Exa calls concurrently (peak 8 req/s
 * across 2 users).
 *
 * - low:    no web research at all (0 rounds) — answer directly from the
 *           model's own knowledge in a single pass.
 * - medium: single-round research (up to 4 queries, up to 8 condensed sources).
 * - high:   two-round deep research (up to 5 initial queries + gap check with
 *           up to 4 follow-up queries, up to 14 condensed sources total).
 */
export type EffortLevel = "low" | "medium" | "high";

export type EffortConfig = {
  /** Number of retrieval rounds (0 = direct answer, 1 = single pass, 2 = gap-checked). */
  rounds: 0 | 1 | 2;
  /** Max search queries generated in Round 1. */
  queriesPerRound: number;
  /** Max follow-up search queries generated in Round 2 (when rounds === 2). */
  followUpQueries: number;
  /** Number of Exa search results requested per query. */
  resultsPerQuery: number;
  /** Total cap on unique URLs condensed across all rounds. */
  maxSources: number;
  /** Cap on unique URLs condensed in Round 1 (leaves room for Round 2). */
  round1MaxSources: number;
};

const EFFORT_CONFIG: Record<EffortLevel, EffortConfig> = {
  low: {
    rounds: 0,
    queriesPerRound: 0,
    followUpQueries: 0,
    resultsPerQuery: 0,
    maxSources: 0,
    round1MaxSources: 0,
  },
  medium: {
    rounds: 1,
    queriesPerRound: 4,
    followUpQueries: 0,
    resultsPerQuery: 4,
    maxSources: 8,
    round1MaxSources: 8,
  },
  high: {
    rounds: 2,
    queriesPerRound: 5,
    followUpQueries: 4,
    resultsPerQuery: 4,
    maxSources: 14,
    round1MaxSources: 8,
  },
};

export const DEFAULT_EFFORT: EffortLevel = "medium";

export const EFFORT_OPTIONS: {
  id: EffortLevel;
  label: string;
  hint: string;
}[] = [
  { id: "low", label: "Low", hint: "No web search — answer directly" },
  { id: "medium", label: "Medium", hint: "Balanced research (default)" },
  { id: "high", label: "High", hint: "Two-pass deep research" },
];

function isValidEffort(value: unknown): value is EffortLevel {
  return value === "low" || value === "medium" || value === "high";
}

/** Resolve an untrusted value to a valid effort config, falling back to default. */
export function effortConfig(value: unknown): EffortConfig {
  return EFFORT_CONFIG[isValidEffort(value) ? value : DEFAULT_EFFORT];
}
