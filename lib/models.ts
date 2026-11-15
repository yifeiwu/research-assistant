import type { GroqProviderOptions } from "@ai-sdk/groq";

export type GroqModel = {
  id: string;
  label: string;
  hint?: string;
  /**
   * Whether the model is a reasoning model that accepts Groq's
   * `reasoning_format` parameter. Non-reasoning models reject the request
   * with a 400 if it's sent, so we only pass it when this is true.
   */
  reasoning?: boolean;
  /**
   * Whether the model accepts `reasoning_effort: "none"` to disable thinking
   * completely on auxiliary stages (supported by Qwen 3.8 27B, rejected by
   * GPT-OSS which requires `"low"` as its minimum).
   */
  supportsZeroReasoning?: boolean;
  /**
   * Per-model cap on synthesis `maxOutputTokens` when the org's OTPM limit is
   * tighter than the default synthesis cap (Qwen 3.8 27B allows 1,000 OTPM).
   */
  maxSynthesisTokens?: number;
  /**
   * Per-minute token limits used to seed the shared budgets in
   * `lib/agent/scheduler.ts`. `tpm` is Groq's combined limit and is corrected
   * at runtime from the `x-ratelimit-limit-tokens` response header; `itpm` /
   * `otpm` are the org-specific input/output split, which Groq does not
   * report in headers, so they are only as accurate as these values.
   */
  limits?: GroqModelLimits;
};

export type GroqModelLimits = {
  tpm?: number;
  itpm?: number;
  otpm?: number;
};

export type GroqModelRole = "synthesis" | "auxiliary";

const DEFAULT_SYNTHESIS_MAX_TOKENS = 3_500;

/**
 * Curated list of Groq models available on the free tier. Because the research
 * pipeline is deterministic and plain-text only, models do not need native
 * function/tool calling support.
 */
export const GROQ_MODELS: GroqModel[] = [
  {
    id: "qwen/qwen3.8-27b",
    label: "Qwen 3.8 27B",
    hint: "Balanced reasoning",
    reasoning: true,
    supportsZeroReasoning: true,
    maxSynthesisTokens: 900,
    limits: { tpm: 8_000, itpm: 7_000, otpm: 1_000 },
  },
  {
    id: "openai/gpt-oss-120b",
    label: "GPT-OSS 120B",
    hint: "Most capable open model",
    reasoning: true,
    limits: { tpm: 8_000 },
  },
  {
    id: "openai/gpt-oss-20b",
    label: "GPT-OSS 20B",
    hint: "Light & fast",
    reasoning: true,
    limits: { tpm: 8_000 },
  },
];

/** Seed per-minute limits for a model; `undefined` for unknown custom models. */
export function groqModelLimits(
  id: string | undefined | null,
): GroqModelLimits | undefined {
  return id ? GROQ_MODELS.find((m) => m.id === id)?.limits : undefined;
}

export const DEFAULT_GROQ_MODEL = "openai/gpt-oss-120b";

/** Preferred fallback priority when a model's rate-limit bucket is hot. */
const FALLBACK_PRIORITY: readonly string[] = [
  "openai/gpt-oss-120b",
  "openai/gpt-oss-20b",
  "qwen/qwen3.8-27b",
];

export function isValidGroqModel(id: string | undefined | null): id is string {
  return !!id && GROQ_MODELS.some((m) => m.id === id);
}

/**
 * Human-friendly label for a Groq model id (e.g. "GPT-OSS 120B"). Falls back to
 * the raw id for unknown models (e.g. a custom `GROQ_MODEL` env override) so the
 * caller always has something presentable to show the user.
 */
export function groqModelLabel(id: string | undefined | null): string {
  const known = id ? GROQ_MODELS.find((m) => m.id === id) : undefined;
  return known?.label ?? id ?? "the selected model";
}

/**
 * Provider options for a Groq call given its pipeline role:
 * - `"synthesis"` surfaces parsed reasoning tokens to the UI.
 * - `"auxiliary"` (planner, gap check, summarizer) disables reasoning on Qwen
 *   (`effort: "none", format: "hidden"`) and minimizes it on GPT-OSS
 *   (`effort: "low"`), avoiding wasted output-token reservations.
 * Unknown custom models return `undefined` so unsupported fields are never sent.
 */
export function groqReasoningOptions(
  id: string | undefined | null,
  role: GroqModelRole,
): { groq: GroqProviderOptions } | undefined {
  const known = id ? GROQ_MODELS.find((m) => m.id === id) : undefined;
  if (!known?.reasoning) return undefined;

  if (role === "synthesis") {
    return { groq: { reasoningFormat: "parsed" } };
  }

  if (known.supportsZeroReasoning) {
    return {
      groq: {
        reasoningEffort: "none",
        reasoningFormat: "hidden",
      },
    };
  }

  return {
    groq: {
      reasoningEffort: "low",
      reasoningFormat: "parsed",
    },
  };
}

/**
 * Safe `maxOutputTokens` reservation for final synthesis on `id`. Caps Qwen at
 * 900 tokens so a single synthesis request never exceeds its 1,000 OTPM limit.
 */
export function maxSynthesisOutputTokens(
  id: string | undefined | null,
  defaultMax: number = DEFAULT_SYNTHESIS_MAX_TOKENS,
): number {
  const known = id ? GROQ_MODELS.find((m) => m.id === id) : undefined;
  if (known?.maxSynthesisTokens != null) {
    return Math.min(known.maxSynthesisTokens, defaultMax);
  }
  return defaultMax;
}

/** Ordered fallback model IDs from `GROQ_MODELS`, excluding `primaryModelId`. */
export function fallbackModelsFor(
  primaryModelId: string | undefined | null,
): string[] {
  const validIds = new Set(GROQ_MODELS.map((m) => m.id));
  const ordered = [
    ...FALLBACK_PRIORITY.filter((id) => validIds.has(id)),
    ...GROQ_MODELS.map((m) => m.id),
  ];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ordered) {
    if (id === primaryModelId || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}
