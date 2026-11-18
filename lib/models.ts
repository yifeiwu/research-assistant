import type { GroqProviderOptions } from "@ai-sdk/groq";
import type { EffortLevel } from "./effort";

export type GroqModelLimits = {
  tpm?: number;
  itpm?: number;
  otpm?: number;
};

type GroqModelPool = "reasoning" | "summarizer";

type GroqModel = {
  id: string;
  pool: GroqModelPool;
  /**
   * Whether the model supports reasoning effort tuning on Groq. Non-reasoning
   * instruct models (e.g. `allam-2-7b`) reject requests with HTTP 400 if
   * reasoning fields are sent.
   */
  reasoning?: boolean;
  /**
   * Whether the model accepts `reasoning_format: "parsed" | "hidden"`.
   * Per Groq's Reasoning docs, `qwen/qwen3.8-27b` accepts `reasoning_format`,
   * whereas `openai/gpt-oss-120b` and `openai/gpt-oss-20b` do NOT support
   * `reasoning_format` (they return parsed `message.reasoning` natively).
   */
  supportsReasoningFormat?: boolean;
  /**
   * Whether the model accepts `reasoning_effort: "none"` to disable thinking
   * completely (supported by Qwen 3.8 27B, rejected by GPT-OSS which requires
   * `"low"` as its minimum).
   */
  supportsZeroReasoning?: boolean;
  /** Per-model cap on synthesis `maxOutputTokens` (Qwen 3.8 27B allows 1,000 OTPM). */
  maxSynthesisTokens?: number;
  /** Per-model cap on batched summary `maxOutputTokens` (2 * 450 = 900 <= 1,000 OTPM). */
  maxSummaryTokens?: number;
  /**
   * Per-model cap on total input characters when batch-condensing sources
   * (e.g. `allam-2-7b` has a 4,096-token total context window).
   */
  maxSummaryInputChars?: number;
  /** Per-minute token limits used to seed shared budgets in `lib/agent/groq-budget.ts`. */
  limits?: GroqModelLimits;
};

export type GroqModelRole = "synthesis" | "auxiliary";

const DEFAULT_SYNTHESIS_MAX_TOKENS = 4_000;
const DEFAULT_SUMMARY_MAX_TOKENS = 1_000;
const TPM_SAFETY_MARGIN = 500;
const HARD_MIN_SYNTHESIS_TOKENS = 256;

/**
 * Curated free-tier Groq text-generation models partitioned into two fungible
 * quota pools:
 * - `"reasoning"`: larger frontier models (`openai/gpt-oss-120b`, `openai/gpt-oss-20b`)
 *   with 8,000 TPM and no 1,000 OTPM ceiling, giving final synthesis a full
 *   4,000-token completion budget so answers never truncate mid-section.
 * - `"summarizer"`: `qwen/qwen3.8-27b` (1,000 OTPM cap fits 450-token summary
 *   batches with zero thinking tokens) and `allam-2-7b` (fast 7B instruct model).
 */
const GROQ_MODELS: GroqModel[] = [
  {
    id: "openai/gpt-oss-120b",
    pool: "reasoning",
    reasoning: true,
    limits: { tpm: 8_000 },
  },
  {
    id: "openai/gpt-oss-20b",
    pool: "reasoning",
    reasoning: true,
    limits: { tpm: 8_000 },
  },
  {
    id: "qwen/qwen3.8-27b",
    pool: "summarizer",
    reasoning: true,
    supportsReasoningFormat: true,
    supportsZeroReasoning: true,
    maxSynthesisTokens: 900,
    maxSummaryTokens: 850,
    limits: { tpm: 8_000, itpm: 7_000, otpm: 1_000 },
  },
  {
    id: "allam-2-7b",
    pool: "summarizer",
    maxSynthesisTokens: 900,
    maxSummaryTokens: 850,
    maxSummaryInputChars: 6_000,
    limits: { tpm: 6_000 },
  },
];

export const REASONING_POOL: string[] = GROQ_MODELS.filter(
  (m) => m.pool === "reasoning",
).map((m) => m.id);

export const SUMMARIZER_POOL: string[] = GROQ_MODELS.filter(
  (m) => m.pool === "summarizer",
).map((m) => m.id);

function findModel(id: string | undefined | null): GroqModel | undefined {
  return id ? GROQ_MODELS.find((m) => m.id === id) : undefined;
}

/** Seed per-minute token limits for `id`, or `undefined` for unknown custom models. */
export function groqModelLimits(
  id: string | undefined | null,
): GroqModelLimits | undefined {
  return findModel(id)?.limits;
}

/**
 * Provider options for a Groq call given its pipeline role:
 * - `"synthesis"`:
 *   - On GPT-OSS (`maxSynthesisTokens == null`), sets `reasoningEffort: "low"`
 *     (or `"medium"` on high effort) so reasoning tokens stay compact (~200–500
 *     tokens) and leave the rest of the 4,000-token budget for the final answer.
 *   - On tight-OTPM fallback models supporting zero reasoning (Qwen 3.8 27B,
 *     capped at 900 OTPM), sets `reasoningEffort: "none"` so 100% of the 900
 *     output tokens go to the user-visible answer instead of `<think>` tokens.
 * - `"auxiliary"` disables reasoning on Qwen (`effort: "none", format: "hidden"`)
 *   and minimizes it on GPT-OSS (`effort: "low"`).
 */
export function groqReasoningOptions(
  id: string | undefined | null,
  role: GroqModelRole,
  effortLevel?: EffortLevel,
): { groq: GroqProviderOptions } | undefined {
  const known = findModel(id);
  if (!known?.reasoning) return undefined;

  if (role === "synthesis") {
    if (known.maxSynthesisTokens != null && known.supportsZeroReasoning) {
      return {
        groq: {
          reasoningEffort: "none",
          ...(known.supportsReasoningFormat ? { reasoningFormat: "hidden" } : {}),
        },
      };
    }
    const effort: "low" | "medium" = effortLevel === "high" ? "medium" : "low";
    return {
      groq: {
        reasoningEffort: effort,
        ...(known.supportsReasoningFormat ? { reasoningFormat: "parsed" } : {}),
      },
    };
  }

  return known.supportsZeroReasoning
    ? {
        groq: {
          reasoningEffort: "none",
          ...(known.supportsReasoningFormat ? { reasoningFormat: "hidden" } : {}),
        },
      }
    : {
        groq: {
          reasoningEffort: "low",
          ...(known.supportsReasoningFormat ? { reasoningFormat: "parsed" } : {}),
        },
      };
}

/** Safe `maxOutputTokens` reservation for final synthesis on `id`. */
export function maxSynthesisOutputTokens(
  id: string | undefined | null,
  defaultMax: number = DEFAULT_SYNTHESIS_MAX_TOKENS,
): number {
  const cap = findModel(id)?.maxSynthesisTokens;
  return cap != null ? Math.min(cap, defaultMax) : defaultMax;
}

/**
 * Compute synthesis `maxOutputTokens` for `id` that also fits alongside
 * `estInputTokens` inside the model's per-request/per-minute `tpm` ceiling
 * (preventing HTTP 413s on multi-turn follow-up conversations).
 */
export function fitSynthesisOutputTokens(
  id: string | undefined | null,
  estInputTokens: number,
  defaultMax: number = DEFAULT_SYNTHESIS_MAX_TOKENS,
): number {
  const modelMax = maxSynthesisOutputTokens(id, defaultMax);
  const tpm = groqModelLimits(id)?.tpm;
  if (!tpm || estInputTokens <= 0) return modelMax;
  const available = tpm - TPM_SAFETY_MARGIN - Math.ceil(estInputTokens);
  const floor = Math.min(modelMax, HARD_MIN_SYNTHESIS_TOKENS);
  return Math.max(floor, Math.min(modelMax, available));
}

/**
 * Compute `maxOutputTokens` for condensing a batch of `sourceCount` sources on
 * `id`, scaling with batch size and adding headroom when `id` spends tokens on
 * `low` reasoning (e.g. GPT-OSS spillover) while respecting per-model OTPM caps.
 */
export function fitSummaryOutputTokens(
  id: string | undefined | null,
  sourceCount: number,
  opts?: { deep?: boolean; defaultMax?: number },
): number {
  const modelCap = maxSummaryOutputTokens(
    id,
    opts?.defaultMax ?? DEFAULT_SUMMARY_MAX_TOKENS,
  );
  const count = Math.max(1, sourceCount);
  const perSource = opts?.deep ? 280 : 220;
  const known = findModel(id);
  const reasoningOverhead =
    known?.reasoning && !known.supportsZeroReasoning ? 200 : 60;
  const desired = Math.max(400, count * perSource + reasoningOverhead);
  return Math.min(modelCap, desired);
}
export function maxSummaryOutputTokens(
  id: string | undefined | null,
  defaultMax: number = DEFAULT_SUMMARY_MAX_TOKENS,
): number {
  const cap = findModel(id)?.maxSummaryTokens;
  return cap != null ? Math.min(cap, defaultMax) : defaultMax;
}

/** Safe batch input character cap for source condensation on `id`. */
export function maxSummaryBatchInputChars(
  id: string | undefined | null,
  defaultCap: number,
): number {
  const cap = findModel(id)?.maxSummaryInputChars;
  return cap != null ? Math.min(cap, defaultCap) : defaultCap;
}
