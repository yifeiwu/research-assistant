export type GroqModel = {
  id: string;
  label: string;
  hint?: string;
};

/**
 * Curated list of Groq models that are available on the free tier AND support
 * tool calling (required for the search/crawl agent loop).
 *
 * Groq's free tier grants access to all supported models; these are the
 * production/function-calling-capable ones suitable for this assistant.
 */
export const GROQ_MODELS: GroqModel[] = [
  {
    id: "llama-3.3-70b-versatile",
    label: "Llama 3.3 70B",
    hint: "Balanced default",
  },
  {
    id: "llama-3.1-8b-instant",
    label: "Llama 3.1 8B",
    hint: "Fastest",
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
  {
    id: "meta-llama/llama-4-maverick-17b-128e-instruct",
    label: "Llama 4 Maverick 17B",
  },
  {
    id: "qwen/qwen3-32b",
    label: "Qwen 3 32B",
  },
  {
    id: "moonshotai/kimi-k2-instruct",
    label: "Kimi K2",
    hint: "Strong tool use",
  },
];

export const DEFAULT_GROQ_MODEL = "llama-3.3-70b-versatile";

export function isValidGroqModel(id: string | undefined | null): id is string {
  return !!id && GROQ_MODELS.some((m) => m.id === id);
}
