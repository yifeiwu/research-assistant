import "server-only";
import type { LanguageModel } from "ai";
import { createGroq, type GroqProviderSettings } from "@ai-sdk/groq";
import {
  fallbackModelsFor,
  isValidGroqModel,
} from "@/lib/models";
import { serverConfig } from "@/lib/config";
import {
  createResilientGroqFetch,
  type GroqCooldownDb,
  type GroqFallbackEvent,
} from "./groq-rate-limit";

export type ResolvedModels = {
  selectedModel: string;
  mainModel: LanguageModel;
  plannerModel: LanguageModel;
  plannerModelId: string;
  summaryModel: LanguageModel;
  summaryModelId: string;
  modelInfo: string;
};

export type ModelResolutionError = { error: string; status: number };

export function isResolutionError(
  value: ResolvedModels | ModelResolutionError,
): value is ModelResolutionError {
  return "error" in value;
}

/**
 * Resolve independent Groq models for synthesis (`mainModel`), query planning /
 * gap checks (`plannerModel`), and source condensation (`summaryModel`) so auxiliary
 * stages do not drain the synthesis model's per-minute token bucket.
 */
export function resolveModels(input: {
  model?: string;
  onSynthesisFallback?: (event: GroqFallbackEvent) => void;
  apiKey?: string;
  db?: GroqCooldownDb | null;
  baseFetch?: NonNullable<GroqProviderSettings["fetch"]>;
  sleep?: (ms: number) => Promise<void>;
}): ResolvedModels | ModelResolutionError {
  const apiKey = input.apiKey ?? process.env.GROQ_API_KEY;
  if (!apiKey) {
    return {
      error: "GROQ_API_KEY is not set on the server.",
      status: 500,
    };
  }

  const selectedModel = isValidGroqModel(input.model)
    ? input.model
    : serverConfig.groqModel;

  // Keep auxiliary stages off `selectedModel`'s Groq quota bucket:
  // - Planner defaults to `openai/gpt-oss-20b`, shifting to `qwen/qwen3.8-27b`
  //   when the user explicitly selected `openai/gpt-oss-20b` for synthesis.
  // - Summarizer defaults to `qwen/qwen3.8-27b`, shifting to `openai/gpt-oss-20b`
  //   when the user selected `qwen/qwen3.8-27b` so Qwen's 1k OTPM is saved for the answer.
  const plannerModelId =
    selectedModel === serverConfig.plannerModel
      ? serverConfig.summaryModel
      : serverConfig.plannerModel;

  const summaryModelId =
    selectedModel === serverConfig.summaryModel
      ? serverConfig.plannerModel
      : serverConfig.summaryModel;

  const synthesisFallbacks = fallbackModelsFor(selectedModel);
  const plannerFallbacks = fallbackModelsFor(plannerModelId).filter(
    (id) => id !== selectedModel,
  );
  const summaryFallbacks = fallbackModelsFor(summaryModelId).filter(
    (id) => id !== selectedModel,
  );

  const mainProvider = createGroq({
    apiKey,
    fetch: createResilientGroqFetch({
      stage: "synthesis",
      primaryModel: selectedModel,
      fallbackModels: synthesisFallbacks,
      onFallback: input.onSynthesisFallback,
      db: input.db,
      baseFetch: input.baseFetch,
      sleep: input.sleep,
    }),
  });

  const plannerProvider = createGroq({
    apiKey,
    fetch: createResilientGroqFetch({
      stage: "planner",
      primaryModel: plannerModelId,
      fallbackModels: plannerFallbacks,
      db: input.db,
      baseFetch: input.baseFetch,
      sleep: input.sleep,
    }),
  });

  const summaryProvider = createGroq({
    apiKey,
    fetch: createResilientGroqFetch({
      stage: "summary",
      primaryModel: summaryModelId,
      fallbackModels: summaryFallbacks,
      db: input.db,
      baseFetch: input.baseFetch,
      sleep: input.sleep,
    }),
  });

  return {
    selectedModel,
    mainModel: mainProvider(selectedModel),
    plannerModel: plannerProvider(plannerModelId),
    plannerModelId,
    summaryModel: summaryProvider(summaryModelId),
    summaryModelId,
    modelInfo: `groq ${selectedModel}`,
  };
}
