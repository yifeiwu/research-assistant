import "server-only";
import type { LanguageModel } from "ai";
import { createGroq } from "@ai-sdk/groq";
import {
  groqModelSupportsReasoning,
  isValidGroqModel,
} from "@/lib/models";
import { serverConfig } from "@/lib/config";

export type ResolvedModels = {
  mainModel: LanguageModel;
  summaryModel: LanguageModel;
  summaryModelId: string;
  modelInfo: string;
  supportsReasoning: boolean;
};

export type ModelResolutionError = { error: string; status: number };

export function isResolutionError(
  value: ResolvedModels | ModelResolutionError,
): value is ModelResolutionError {
  return "error" in value;
}

/** Resolve the Groq main + summary models for a request. Groq is the only provider. */
export function resolveModels(input: {
  model?: string;
}): ResolvedModels | ModelResolutionError {
  if (!process.env.GROQ_API_KEY) {
    return {
      error: "GROQ_API_KEY is not set on the server.",
      status: 500,
    };
  }
  const groq = createGroq({ apiKey: process.env.GROQ_API_KEY });
  const selectedModel = isValidGroqModel(input.model)
    ? input.model
    : serverConfig.groqModel;
  const summaryModelId = serverConfig.summaryModel;
  return {
    mainModel: groq(selectedModel),
    summaryModel: groq(summaryModelId),
    summaryModelId,
    modelInfo: `groq ${selectedModel}`,
    supportsReasoning: groqModelSupportsReasoning(selectedModel),
  };
}

