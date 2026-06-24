export type GroqModel = {
  id: string;
  label: string;
  hint?: string;
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
  },
  {
    id: "qwen/qwen3-32b",
    label: "Qwen 3 32B",
  },
  {
    id: "openai/gpt-oss-120b",
    label: "GPT-OSS 120B",
    hint: "Most capable open model",
  },
  {
    id: "openai/gpt-oss-20b",
    label: "GPT-OSS 20B",
    hint: "Light & fast",
  },
  {
    id: "meta-llama/llama-4-scout-17b-16e-instruct",
    label: "Llama 4 Scout 17B",
  },
];

export const DEFAULT_GROQ_MODEL = "qwen/qwen3.6-27b";

export function isValidGroqModel(id: string | undefined | null): id is string {
  return !!id && GROQ_MODELS.some((m) => m.id === id);
}
