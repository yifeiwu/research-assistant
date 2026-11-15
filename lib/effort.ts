/**
 * Research "effort" controls how long and how broadly the research pipeline
 * searches before the answer is written:
 *
 * - `level`: the named effort tier ("low" | "medium" | "high").
 * - `rounds`: how many sequential research rounds may run. A round after the
 *   first only runs if the gap check over the notes so far asks for more.
 * - `initialQueries`: how many diverse query angles Round 1 may plan.
 * - `followUpQueries`: how many follow-up searches each gap check may ask for.
 *
 * Per-round source caps and the limit of 2 parallel searches per conversation
 * thread live in `serverConfig` (lib/config.ts, lib/exa.ts).
 *
 * - low:    no web research (0 rounds); the model answers directly.
 * - medium: up to 2 rounds, 2 initial queries.
 * - high:   up to 4 rounds, 3 initial queries (adds counterpoint/primary angle).
 */
export type EffortLevel = "low" | "medium" | "high";

export type EffortConfig = {
  /** Selected effort tier. */
  level: EffortLevel;
  /** Max sequential research rounds (0 = answer directly, no search). */
  rounds: number;
  /** Max search queries planned in Round 1. */
  initialQueries: number;
  /** Max follow-up search queries per gap check. */
  followUpQueries: number;
};

const EFFORT_CONFIG: Record<EffortLevel, EffortConfig> = {
  low: { level: "low", rounds: 0, initialQueries: 0, followUpQueries: 0 },
  medium: { level: "medium", rounds: 2, initialQueries: 2, followUpQueries: 2 },
  high: { level: "high", rounds: 4, initialQueries: 3, followUpQueries: 2 },
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
