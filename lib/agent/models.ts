import "server-only";
import type { LanguageModel } from "ai";
import { createGroq, type GroqProviderSettings } from "@ai-sdk/groq";
import { serverConfig } from "@/lib/config";
import {
  acquirePoolModel,
  sharedGroqBudget,
  type GroqBudget,
} from "./groq-budget";
import {
  createResilientGroqFetch,
  resolveGroqCooldownDb,
  type GroqCooldownDb,
  type GroqStage,
} from "./groq-rate-limit";
import type { StageRunner } from "./stage";

export type ModelPools = {
  reasoning: string[];
  summarizer: string[];
};

export type ResolvedModels = {
  pools: ModelPools;
  stages: Record<GroqStage, StageRunner>;
};

export type ModelResolutionError = { error: string; status: number };

export function isResolutionError(value: object): value is ModelResolutionError {
  return "error" in value;
}

export type ModelPlan = {
  apiKey: string;
  pools: ModelPools;
};

/**
 * Validate server credentials and resolve the active reasoning and summarizer
 * model pools without instantiating providers.
 */
export function planModels(input?: {
  apiKey?: string;
  pools?: Partial<ModelPools>;
}): ModelPlan | ModelResolutionError {
  const apiKey = input?.apiKey ?? process.env.GROQ_API_KEY;
  if (!apiKey) {
    return {
      error: "GROQ_API_KEY is not set on the server.",
      status: 500,
    };
  }

  const reasoning = (input?.pools?.reasoning ?? serverConfig.reasoningPool).filter(Boolean);
  const summarizer = (input?.pools?.summarizer ?? serverConfig.summarizerPool).filter(Boolean);

  if (reasoning.length === 0 || summarizer.length === 0) {
    return {
      error: "Groq reasoning and summarizer model pools must not be empty.",
      status: 500,
    };
  }

  return {
    apiKey,
    pools: { reasoning, summarizer },
  };
}

/** Process-wide round-robin cursors so consecutive calls spread load evenly across pool peers. */
const sharedPoolCursors = new Map<string, number>();

/**
 * Build budgeted, pool-backed stage runners:
 * - `synthesis` and `planner` lease from `pools.reasoning` (spilling over to
 *   `pools.summarizer` when the reasoning pool is saturated or retired).
 * - `summary` leases from `pools.summarizer` (spilling over to `pools.reasoning`
 *   with synthesis headroom reserved when the summarizer pool is saturated or retired).
 */
export function resolveModels(input?: {
  pools?: Partial<ModelPools>;
  apiKey?: string;
  db?: GroqCooldownDb | null;
  budget?: GroqBudget;
  cursors?: Map<string, number>;
  deadlineAt?: number;
  onWait?: (stage: GroqStage, resumeAt: number | null) => void | Promise<void>;
  now?: () => number;
  baseFetch?: NonNullable<GroqProviderSettings["fetch"]>;
  sleep?: (ms: number) => Promise<void>;
}): ResolvedModels | ModelResolutionError {
  const plan = planModels(input);
  if (isResolutionError(plan)) return plan;
  const { apiKey, pools } = plan;

  const budget = input?.budget ?? sharedGroqBudget();
  const cursors =
    input?.cursors ??
    (input?.db !== undefined || input?.budget !== undefined
      ? new Map<string, number>()
      : sharedPoolCursors);
  const nowFn = input?.now ?? Date.now;
  const resolveCooldownDb = resolveGroqCooldownDb(input?.db, "pool");

  const stageRouting: Record<GroqStage, { pool: string[]; fallbackPool: string[] }> = {
    synthesis: {
      pool: pools.reasoning,
      fallbackPool: pools.summarizer.filter((m) => m !== "allam-2-7b"),
    },
    planner: { pool: pools.reasoning, fallbackPool: pools.summarizer },
    summary: { pool: pools.summarizer, fallbackPool: pools.reasoning },
  };

  const modelCache = new Map<string, LanguageModel>();
  const modelFor = (stage: GroqStage, id: string): LanguageModel => {
    const cacheKey = `${stage}:${id}`;
    const cached = modelCache.get(cacheKey);
    if (cached) return cached;

    const { pool, fallbackPool } = stageRouting[stage];
    const peers = [...pool, ...fallbackPool].filter((m) => m !== id);
    const provider = createGroq({
      apiKey,
      fetch: createResilientGroqFetch({
        stage,
        primaryModel: id,
        fallbackModels: peers,
        db: input?.db,
        budget,
        onWait: input?.onWait,
        now: nowFn,
        baseFetch: input?.baseFetch,
        sleep: input?.sleep,
      }),
    });
    const model = provider(id);
    modelCache.set(cacheKey, model);
    return model;
  };

  const stageRunner = (stage: GroqStage): StageRunner => {
    const { pool, fallbackPool } = stageRouting[stage];
    return {
      async lease(req) {
        const acquired = await acquirePoolModel({
          stage,
          pool,
          fallbackPool,
          estInputTokens: req?.estInputTokens ?? 500,
          maxOutputTokens: req?.maxOutputTokens ?? 500,
          budget,
          cooldownDb: resolveCooldownDb,
          cursors,
          deadlineAt: input?.deadlineAt,
          onWait: input?.onWait,
          signal: req?.signal,
          now: nowFn,
          sleep: input?.sleep,
        });
        return {
          model: modelFor(stage, acquired.modelId),
          modelId: acquired.modelId,
        };
      },
    };
  };

  return {
    pools,
    stages: {
      synthesis: stageRunner("synthesis"),
      planner: stageRunner("planner"),
      summary: stageRunner("summary"),
    },
  };
}
