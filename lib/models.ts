import type { GroqProviderOptions } from "@ai-sdk/groq";
import type { EffortLevel } from "./effort";

export type GroqModelLimits = {
  tpm?: number;
  itpm?: number;
  otpm?: number;
};

export type GroqModel = {
  id: string;
  label: string;
  hint?: string;
  /**
   * Whether the model accepts `reasoning_effort: "none"` to disable thinking
   * completely on auxiliary stages (supported by Qwen 3.8 27B, rejected by
   * GPT-OSS which requires `"low"` as its minimum).
   */
  supportsZeroReasoning?: boolean;
  /** Per-model cap on synthesis `maxOutputTokens` (Qwen 3.8 27B allows 1,000 OTPM). */
  maxSynthesisTokens?: number;
  /** Per-model cap on batched summary `maxOutputTokens` (2 * 450 = 900 <= 1,000 OTPM). */
  maxSummaryTokens?: number;
  /** Per-minute token limits used to seed shared budgets in `lib/agent/scheduler.ts`. */
  limits?: GroqModelLimits;
};

export type GroqModelRole = "synthesis" | "auxiliary";

const DEFAULT_SYNTHESIS_MAX_TOKENS = 3_500;
const DEFAULT_SUMMARY_MAX_TOKENS = 650;

/**
 * Curated list of Groq models available on the free tier, ordered by capability
 * and fallback preference (highest-headroom models first).
 */
export const GROQ_MODELS: GroqModel[] = [
  {
    id: "openai/gpt-oss-120b",
    label: "GPT-OSS 120B",
    hint: "Most capable open model",
    limits: { tpm: 8_000 },
  },
  {
    id: "openai/gpt-oss-20b",
    label: "GPT-OSS 20B",
    hint: "Light & fast",
    limits: { tpm: 8_000 },
  },
  {
    id: "qwen/qwen3.8-27b",
    label: "Qwen 3.8 27B",
    hint: "Balanced reasoning",
    supportsZeroReasoning: true,
    maxSynthesisTokens: 900,
    maxSummaryTokens: 450,
    limits: { tpm: 8_000, itpm: 7_000, otpm: 1_000 },
  },
];

export const DEFAULT_GROQ_MODEL = GROQ_MODELS[0].id;

function findModel(id: string | undefined | null): GroqModel | undefined {
  return id ? GROQ_MODELS.find((m) => m.id === id) : undefined;
}

/** Seed per-minute limits for a model; `undefined` for unknown custom models. */
export function groqModelLimits(
  id: string | undefined | null,
): GroqModelLimits | undefined {
  return findModel(id)?.limits;
}

export function isValidGroqModel(id: unknown): id is string {
  return typeof id === "string" && GROQ_MODELS.some((m) => m.id === id);
}

/** Human-friendly label for a Groq model id, falling back to the raw id. */
export function groqModelLabel(id: string | undefined | null): string {
  return findModel(id)?.label ?? id ?? "the selected model";
}

/**
 * Provider options for a Groq call given its pipeline role:
 * - `"synthesis"` surfaces parsed reasoning tokens to the UI, and on models
 *   without a tight 1k OTPM cap sets `reasoningEffort` to `"low"` (low effort)
 *   or `"medium"` (research synthesis).
 * - `"auxiliary"` disables reasoning on Qwen (`effort: "none", format: "hidden"`)
 *   and minimizes it on GPT-OSS (`effort: "low"`).
 * Unknown custom models return `undefined` so unsupported fields are never sent.
 */
export function groqReasoningOptions(
  id: string | undefined | null,
  role: GroqModelRole,
  effortLevel?: EffortLevel,
): { groq: GroqProviderOptions } | undefined {
  const known = findModel(id);
  if (!known) return undefined;

  if (role === "synthesis") {
    if (effortLevel && known.maxSynthesisTokens == null) {
      return {
        groq: {
          reasoningFormat: "parsed",
          reasoningEffort: effortLevel === "low" ? "low" : "medium",
        },
      };
    }
    return { groq: { reasoningFormat: "parsed" } };
  }

  return known.supportsZeroReasoning
    ? { groq: { reasoningEffort: "none", reasoningFormat: "hidden" } }
    : { groq: { reasoningEffort: "low", reasoningFormat: "parsed" } };
}

/** Safe `maxOutputTokens` reservation for final synthesis on `id`. */
export function maxSynthesisOutputTokens(
  id: string | undefined | null,
  defaultMax: number = DEFAULT_SYNTHESIS_MAX_TOKENS,
): number {
  const cap = findModel(id)?.maxSynthesisTokens;
  return cap != null ? Math.min(cap, defaultMax) : defaultMax;
}

/** Safe `maxOutputTokens` reservation for batched source condensation on `id`. */
export function maxSummaryOutputTokens(
  id: string | undefined | null,
  defaultMax: number = DEFAULT_SUMMARY_MAX_TOKENS,
): number {
  const cap = findModel(id)?.maxSummaryTokens;
  return cap != null ? Math.min(cap, defaultMax) : defaultMax;
}

/** Ordered fallback model IDs from `GROQ_MODELS`, excluding `primaryModelId`. */
export function fallbackModelsFor(
  primaryModelId: string | undefined | null,
): string[] {
  return GROQ_MODELS.map((m) => m.id).filter((id) => id !== primaryModelId);
}
