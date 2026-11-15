/**
 * Research "effort" controls how long the research pipeline keeps going
 * before the answer is written. It changes two things only:
 *
 * - `rounds`: how many sequential research rounds may run. A round after the
 *   first only runs if the gap check over the notes so far asks for more.
 * - `followUpQueries`: how many follow-up searches each gap check may ask for.
 *
 * Everything else about a round is the same at every effort level and lives
 * in `serverConfig.research` (lib/config.ts): how many searches the first
 * round plans, how many results and sources each round reads, and the cap of
 * 2 parallel searches per conversation thread (lib/exa.ts).
 *
 * - low:    no web research (0 rounds); the model answers directly.
 * - medium: up to 2 rounds.
 * - high:   up to 4 rounds.
 */
export type EffortLevel = "low" | "medium" | "high";

export type EffortConfig = {
  /** Max sequential research rounds (0 = answer directly, no search). */
  rounds: number;
  /** Max follow-up search queries per gap check. */
  followUpQueries: number;
};

const EFFORT_CONFIG: Record<EffortLevel, EffortConfig> = {
  low: { rounds: 0, followUpQueries: 0 },
  medium: { rounds: 2, followUpQueries: 2 },
  high: { rounds: 4, followUpQueries: 2 },
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
