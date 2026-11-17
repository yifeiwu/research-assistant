/**
 * Research "effort" controls how deeply the sequential research pipeline
 * searches, reads, and verifies sources before the answer is written:
 *
 * - `low`:    no web research (0 rounds); the model answers directly.
 * - `medium`: up to 3 sequential research rounds (Round 1 + up to 2 gap-checked follow-ups).
 * - `high`:   up to 5 sequential deep-research rounds (`deep: true`: larger per-round
 *             source caps, micro-batch condensation, and expanded synthesis budget).
 */
export type EffortLevel = "low" | "medium" | "high";

export type EffortConfig = {
  /** Selected effort tier. */
  level: EffortLevel;
  /** Max sequential single-query research rounds (0 = answer directly, no search). */
  rounds: number;
  /** Enables deep-research upgrades configured in `serverConfig`. */
  deep: boolean;
};

const EFFORT_CONFIG: Record<EffortLevel, EffortConfig> = {
  low: { level: "low", rounds: 0, deep: false },
  medium: { level: "medium", rounds: 3, deep: false },
  high: { level: "high", rounds: 5, deep: true },
};

export const DEFAULT_EFFORT: EffortLevel = "medium";

export const EFFORT_OPTIONS: {
  id: EffortLevel;
  label: string;
  hint: string;
}[] = [
  { id: "low", label: "Low", hint: "No web search — answer directly" },
  { id: "medium", label: "Medium", hint: "Up to 3 sequential research rounds (default)" },
  { id: "high", label: "High", hint: "Up to 5 deep-research rounds with larger source budgets (slower)" },
];

export function isValidEffort(value: unknown): value is EffortLevel {
  return value === "low" || value === "medium" || value === "high";
}

/** Resolve an untrusted value to a valid effort config, falling back to default. */
export function effortConfig(value: unknown): EffortConfig {
  return EFFORT_CONFIG[isValidEffort(value) ? value : DEFAULT_EFFORT];
}
