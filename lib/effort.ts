/**
 * Research "effort" controls how hard the agent works on a question by capping
 * two things: how many agent steps it may take and how many real search/crawl
 * tool calls it may make.
 *
 * - low:    no web research at all (0 tool calls) — answer directly from the
 *           model's own knowledge in a single pass.
 * - medium: balanced research (the default).
 * - high:   deeper, more thorough research with a larger budget.
 */
export type EffortLevel = "low" | "medium" | "high";

export type EffortConfig = {
  /** Max agent steps before the model is forced to write its answer. */
  maxSteps: number;
  /** Max real (non-refused) search/crawl tool calls. 0 disables tools. */
  maxToolCalls: number;
};

const EFFORT_CONFIG: Record<EffortLevel, EffortConfig> = {
  low: { maxSteps: 2, maxToolCalls: 0 },
  medium: { maxSteps: 10, maxToolCalls: 3 },
  high: { maxSteps: 16, maxToolCalls: 6 },
};

export const DEFAULT_EFFORT: EffortLevel = "medium";

export const EFFORT_OPTIONS: {
  id: EffortLevel;
  label: string;
  hint: string;
}[] = [
  { id: "low", label: "Low", hint: "No web search — answer directly" },
  { id: "medium", label: "Medium", hint: "Balanced research (default)" },
  { id: "high", label: "High", hint: "Deeper, more thorough research" },
];

function isValidEffort(value: unknown): value is EffortLevel {
  return value === "low" || value === "medium" || value === "high";
}

/** Resolve an untrusted value to a valid effort config, falling back to default. */
export function effortConfig(value: unknown): EffortConfig {
  return EFFORT_CONFIG[isValidEffort(value) ? value : DEFAULT_EFFORT];
}
