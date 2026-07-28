export type GroqModel = {
  id: string;
  label: string;
  hint?: string;
  /**
   * Whether the model is a reasoning model that accepts Groq's
   * `reasoning_format` parameter. Non-reasoning models (e.g. Llama) reject the
   * request with a 400 if it's sent, so we only pass it when this is true.
   */
  reasoning?: boolean;
};

/**
 * Curated list of Groq models that are available on the free tier AND are
 * reliable at function/tool calling (required for the search/crawl agent loop).
 * Models that are weak at tool calls are intentionally excluded.
 */
export const GROQ_MODELS: GroqModel[] = [
  {
    id: "qwen/qwen3.6-27b",
    label: "Qwen 3.6 27B",
    hint: "Balanced default",
    reasoning: true,
  },
  {
    id: "llama-3.3-70b-versatile",
    label: "Llama 3.3 70B",
    hint: "Reliable tool caller",
  },
  {
    id: "openai/gpt-oss-120b",
    label: "GPT-OSS 120B",
    hint: "Most capable open model",
    reasoning: true,
  },
  {
    id: "openai/gpt-oss-20b",
    label: "GPT-OSS 20B",
    hint: "Light & fast",
    reasoning: true,
  },
];

export const DEFAULT_GROQ_MODEL = "openai/gpt-oss-120b";

export function isValidGroqModel(id: string | undefined | null): id is string {
  return !!id && GROQ_MODELS.some((m) => m.id === id);
}

/**
 * Whether a Groq model accepts the `reasoning_format` provider option. Unknown
 * model ids (e.g. a custom `GROQ_MODEL` env override) default to `false` so we
 * never send a parameter the model might reject.
 */
export function groqModelSupportsReasoning(id: string | undefined | null): boolean {
  return !!id && GROQ_MODELS.some((m) => m.id === id && m.reasoning === true);
}
