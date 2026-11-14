import "server-only";
import type { LanguageModel } from "ai";
import { createGroq } from "@ai-sdk/groq";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import {
  DEFAULT_GROQ_MODEL,
  groqModelSupportsReasoning,
  isValidGroqModel,
} from "@/lib/models";
import {
  isCustomProviderPayload,
  type CustomProviderPayload,
} from "@/lib/provider";

// Cheap, fast model used for the "map" step (per-page summarization).
const DEFAULT_SUMMARY_MODEL = "llama-3.1-8b-instant";

export type ResolvedModels = {
  /** Primary model used for query planning, gap checking, and final synthesis. */
  mainModel: LanguageModel;
  /** Map step: a cheap, fast model condenses each large web document. */
  summaryModel: LanguageModel;
  /** Human-readable model description, for logs. */
  modelInfo: string;
  /**
   * Whether the main model accepts Groq's `reasoning_format` option. Only true
   * for Groq reasoning models; custom endpoints and non-reasoning Groq models
   * (e.g. Llama) are false so we don't send an unsupported parameter.
   */
  supportsReasoning: boolean;
};

/** A failed resolution carries a ready-to-return HTTP error. */
export type ModelResolutionError = { error: string; status: number };

export function isResolutionError(
  value: ResolvedModels | ModelResolutionError,
): value is ModelResolutionError {
  return "error" in value;
}

/** Build the main and summary models for a custom OpenAI-compatible endpoint. */
function buildCustomModels(payload: CustomProviderPayload): ResolvedModels {
  const provider = createOpenAICompatible({
    name: "custom",
    baseURL: payload.baseURL,
    apiKey: payload.apiKey,
  });
  // Custom endpoints expose arbitrary models; use the chosen one for all steps.
  const model = provider(payload.model);
  return {
    mainModel: model,
    summaryModel: model,
    modelInfo: `custom (${payload.baseURL}) ${payload.model}`,
    // Groq-specific reasoning_format never applies to custom endpoints.
    supportsReasoning: false,
  };
}

/** Build the Groq main + summary models from the (validated) request model id. */
function buildGroqModels(model: string | undefined): ResolvedModels {
  const groq = createGroq({
    apiKey: process.env.GROQ_API_KEY,
  });
  // Only allow models from our curated free-tier allowlist; otherwise fall back.
  const selectedModel = isValidGroqModel(model)
    ? model
    : (process.env.GROQ_MODEL ?? DEFAULT_GROQ_MODEL);
  return {
    mainModel: groq(selectedModel),
    summaryModel: groq(process.env.GROQ_SUMMARY_MODEL ?? DEFAULT_SUMMARY_MODEL),
    modelInfo: `groq ${selectedModel}`,
    supportsReasoning: groqModelSupportsReasoning(selectedModel),
  };
}

/**
 * Resolve the models for a request: a custom OpenAI-compatible endpoint when the
 * client supplies one, otherwise Groq. No model is required to support native
 * function/tool calling.
 */
export function resolveModels(input: {
  model?: string;
  provider?: unknown;
}): ResolvedModels | ModelResolutionError {
  if (isCustomProviderPayload(input.provider)) {
    return buildCustomModels(input.provider);
  }
  if (!process.env.GROQ_API_KEY) {
    return {
      error:
        "GROQ_API_KEY is not set on the server. Add it, or configure a custom OpenAI-compatible provider in Settings.",
      status: 500,
    };
  }
  return buildGroqModels(input.model);
}
