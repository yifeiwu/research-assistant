import "server-only";
import type { LanguageModel } from "ai";
import { createGroq } from "@ai-sdk/groq";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import {
  DEFAULT_GROQ_MODEL,
  groqModelSupportsReasoning,
  isValidGroqModel,
} from "@/lib/models";
import { isCustomProviderPayload, type CustomProviderPayload } from "@/lib/provider";
import { groqToolValidationFetch } from "@/lib/groq-tool-fix";

// Cheap, fast model used for the "map" step (per-page summarization).
const DEFAULT_SUMMARY_MODEL = "llama-3.1-8b-instant";

export type ResolvedModels = {
  /** Reduce step: synthesizes the condensed notes into the final answer. */
  mainModel: LanguageModel;
  /** Map step: a cheap, fast model condenses each large tool result. */
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

/** Build the main (reduce) and summary (map) models for a custom endpoint. */
function buildCustomModels(payload: CustomProviderPayload): ResolvedModels {
  const provider = createOpenAICompatible({
    name: "custom",
    baseURL: payload.baseURL,
    apiKey: payload.apiKey,
  });
  // Custom endpoints expose arbitrary models; use the chosen one for both steps.
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
    // Work around Groq/Llama embedding tool args in the tool name.
    fetch: groqToolValidationFetch,
  });
  // Only allow models from our curated free-tier allowlist; otherwise fall back.
  const selectedModel = isValidGroqModel(model)
    ? model
    : (process.env.GROQ_MODEL ?? DEFAULT_GROQ_MODEL);
  return {
    mainModel: groq(selectedModel),
    // Map step: a cheap, fast model condenses each large tool result.
    summaryModel: groq(process.env.GROQ_SUMMARY_MODEL ?? DEFAULT_SUMMARY_MODEL),
    modelInfo: `groq ${selectedModel}`,
    supportsReasoning: groqModelSupportsReasoning(selectedModel),
  };
}

/**
 * Resolve the models for a request: a custom OpenAI-compatible endpoint when the
 * client supplies one, otherwise Groq. Returns an error object (rather than
 * throwing) when required server configuration is missing.
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
