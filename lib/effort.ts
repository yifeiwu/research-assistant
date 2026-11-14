/**
 * Research "effort" controls how deeply the deterministic research pipeline
 * searches and condenses sources before synthesizing an answer.
 *
 * Retrieval is deliberately narrow-but-deep: at most 2 search queries run in
 * parallel in any round, and depth comes from additional sequential rounds
 * (each preceded by a gap check over the notes gathered so far) rather than
 * a wide parallel burst. That keeps a single request's burst well under
 * Exa's 10 req/s global limit and spreads the summarizer / planner model
 * calls over time instead of firing them all in the same rate-limit window.
 *
 * - low:    no web research at all (0 rounds) — answer directly from the
 *           model's own knowledge in a single pass.
 * - medium: up to 2 sequential rounds (2 queries per round, gap check in
 *           between), up to 8 condensed sources total.
 * - high:   up to 4 sequential rounds (2 queries per round, gap check
 *           between rounds), up to 14 condensed sources total.
 */
export type EffortLevel = "low" | "medium" | "high";

export type EffortConfig = {
  /** Max sequential retrieval rounds (0 = direct answer). Later rounds only run if the gap check asks for more. */
  rounds: number;
  /** Max search queries generated in Round 1 (bounds parallel searches in that round). */
  queriesPerRound: number;
  /** Max follow-up search queries generated per gap check (bounds parallel searches in later rounds). */
  followUpQueries: number;
  /** Number of Exa search results requested per query. */
  resultsPerQuery: number;
  /** Total cap on unique URLs condensed across all rounds. */
  maxSources: number;
  /** Cap on unique URLs condensed in any single round. */
  sourcesPerRound: number;
};

const EFFORT_CONFIG: Record<EffortLevel, EffortConfig> = {
  low: {
    rounds: 0,
    queriesPerRound: 0,
    followUpQueries: 0,
    resultsPerQuery: 0,
    maxSources: 0,
    sourcesPerRound: 0,
  },
  medium: {
    rounds: 2,
    queriesPerRound: 2,
    followUpQueries: 2,
    resultsPerQuery: 4,
    maxSources: 8,
    sourcesPerRound: 4,
  },
  high: {
    rounds: 4,
    queriesPerRound: 2,
    followUpQueries: 2,
    resultsPerQuery: 4,
    maxSources: 14,
    sourcesPerRound: 4,
  },
};

export const DEFAULT_EFFORT: EffortLevel = "medium";

export const EFFORT_OPTIONS: {
  id: EffortLevel;
  label: string;
  hint: string;
}[] = [
  { id: "low", label: "Low", hint: "No web search — answer directly" },
  { id: "medium", label: "Medium", hint: "Up to 2 sequential research rounds (default)" },
  { id: "high", label: "High", hint: "Up to 4 sequential deep-research rounds" },
];

function isValidEffort(value: unknown): value is EffortLevel {
  return value === "low" || value === "medium" || value === "high";
}

/** Resolve an untrusted value to a valid effort config, falling back to default. */
export function effortConfig(value: unknown): EffortConfig {
  return EFFORT_CONFIG[isValidEffort(value) ? value : DEFAULT_EFFORT];
}
