import "server-only";
import type { LanguageModel } from "ai";
import { createGroq, type GroqProviderSettings } from "@ai-sdk/groq";
import {
  fallbackModelsFor,
  isValidGroqModel,
} from "@/lib/models";
import { serverConfig } from "@/lib/config";
import { logError } from "@/lib/logger";
import { redis } from "@/lib/redis";
import { sharedGroqBudget, type GroqBudget } from "./groq-budget";
import {
  createResilientGroqFetch,
  type GroqCooldownDb,
  type GroqFallbackEvent,
  type GroqStage,
} from "./groq-rate-limit";
import {
  createModelScheduler,
  isDenied,
  type ModelScheduler,
  type SchedulerStatus,
} from "./scheduler";
import { BudgetDeniedError, type StageRunner } from "./stage";

export type ResolvedModels = {
  selectedModel: string;
  /**
   * The selected model without a budget reservation. Only for an answer the
   * scheduler could neither grant nor usefully defer.
   */
  mainModel: LanguageModel;
  modelInfo: string;
  /**
   * How every stage gets its model: lease before each call. Each stage's
   * `primaryModelId` is the model it prefers.
   */
  stages: Record<GroqStage, StageRunner>;
};

export type ModelResolutionError = { error: string; status: number };

export function isResolutionError(value: object): value is ModelResolutionError {
  return "error" in value;
}

export type ModelPlan = {
  apiKey: string;
  selectedModel: string;
  /** The models each stage may call, in order of preference. */
  candidates: Record<GroqStage, string[]>;
};

/**
 * Decide which Groq models a turn would use, without building any of them:
 * independent models for synthesis, query planning / gap checks and source
 * condensation, so auxiliary stages do not drain the synthesis model's
 * per-minute token bucket.
 */
export function planModels(input: {
  model?: string;
  apiKey?: string;
}): ModelPlan | ModelResolutionError {
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

  return {
    apiKey,
    selectedModel,
    candidates: {
      synthesis: [selectedModel, ...fallbackModelsFor(selectedModel)],
      planner: [
        plannerModelId,
        ...fallbackModelsFor(plannerModelId).filter((id) => id !== selectedModel),
      ],
      summary: [
        summaryModelId,
        ...fallbackModelsFor(summaryModelId).filter((id) => id !== selectedModel),
      ],
    },
  };
}

/**
 * Build the models `planModels` chose: each stage gets a runner that leases
 * a model against the shared budgets before every call.
 */
export function resolveModels(input: {
  model?: string;
  onSynthesisFallback?: (event: GroqFallbackEvent) => void;
  /** Reports budget waits so the turn can show them. */
  onStatus?: (status: SchedulerStatus) => void;
  apiKey?: string;
  db?: GroqCooldownDb | null;
  /** Shared token budgets (defaults to the Redis-backed ones). */
  budget?: GroqBudget;
  scheduler?: ModelScheduler;
  baseFetch?: NonNullable<GroqProviderSettings["fetch"]>;
  sleep?: (ms: number) => Promise<void>;
}): ResolvedModels | ModelResolutionError {
  const plan = planModels(input);
  if (isResolutionError(plan)) return plan;
  const { apiKey, selectedModel, candidates } = plan;

  const budget = input.budget ?? sharedGroqBudget();

  const resolveCooldownDb = (): GroqCooldownDb | undefined => {
    if (input.db === null) return undefined;
    if (input.db) return input.db;
    try {
      return redis() as unknown as GroqCooldownDb;
    } catch (error) {
      logError("groq-cooldown-redis", error, { stage: "scheduler" });
      return undefined;
    }
  };

  const scheduler =
    input.scheduler ??
    createModelScheduler({
      budget,
      cooldownDb: resolveCooldownDb,
      onStatus: input.onStatus,
      sleep: input.sleep,
    });

  const modelCache = new Map<string, LanguageModel>();
  const modelFor = (stage: GroqStage, id: string): LanguageModel => {
    const cacheKey = `${stage}:${id}`;
    const cached = modelCache.get(cacheKey);
    if (cached) return cached;

    // The fetch wrapper treats `id` as its primary, so a model leased by the
    // scheduler (possibly a fallback) gets correct cooldown bookkeeping and
    // can still fall back to the stage's other candidates on a surprise 429.
    const onFallback =
      stage !== "synthesis"
        ? undefined
        : (event: GroqFallbackEvent) =>
            input.onSynthesisFallback?.(
              // Report switches relative to the model the user picked, unless
              // the wrapper ended up back on that very model.
              event.to === selectedModel ? event : { ...event, from: selectedModel },
            );
    const provider = createGroq({
      apiKey,
      fetch: createResilientGroqFetch({
        stage,
        primaryModel: id,
        fallbackModels: candidates[stage].filter((m) => m !== id),
        onFallback,
        db: input.db,
        budget,
        baseFetch: input.baseFetch,
        sleep: input.sleep,
      }),
    });
    const model = provider(id);
    modelCache.set(cacheKey, model);
    return model;
  };

  const stageRunner = (stage: GroqStage): StageRunner => {
    const primaryModelId = candidates[stage][0];
    return {
      primaryModelId,
      async lease(req) {
        const result = await scheduler.acquire({
          stage,
          candidates: candidates[stage],
          estInputTokens: req.estInputTokens,
          maxOutputTokens: req.maxOutputTokens,
          signal: req.signal,
        });
        if (isDenied(result)) throw new BudgetDeniedError(stage, result.waitMs);
        if (stage === "synthesis" && result.model !== selectedModel) {
          input.onSynthesisFallback?.({
            from: selectedModel,
            to: result.model,
            retryAfterMs: result.waitedMs,
          });
        }
        return {
          model: modelFor(stage, result.model),
          modelId: result.model,
          waitedMs: result.waitedMs,
        };
      },
    };
  };

  return {
    selectedModel,
    mainModel: modelFor("synthesis", selectedModel),
    modelInfo: `groq ${selectedModel}`,
    stages: {
      synthesis: stageRunner("synthesis"),
      planner: stageRunner("planner"),
      summary: stageRunner("summary"),
    },
  };
}
