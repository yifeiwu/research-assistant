import "server-only";
import {
  generateText,
  type LanguageModel,
  type ModelMessage,
} from "ai";
import { groqReasoningOptions } from "@/lib/models";
import { estimateTokens } from "@/lib/tokens";

/** The model a stage was cleared to call, after any wait for its window. */
export type StageLease = {
  model: LanguageModel;
  modelId: string;
  waitedMs: number;
};

export type StageLeaseRequest = {
  estInputTokens: number;
  /** Output reservation, which may differ per model (e.g. Qwen's OTPM cap). */
  maxOutputTokens: number | ((modelId: string) => number);
  /** Optional override for how long the scheduler may wait for a token window. */
  maxWaitMs?: number;
  signal?: AbortSignal;
};

/**
 * A pipeline stage's handle on the shared model budgets, and the only way the
 * pipeline gets a model: call `lease` right before a model call to reserve
 * its tokens. It resolves once the call may go
 * ahead (possibly on a fallback model) and throws `BudgetDeniedError` when
 * the wait would not fit, so the caller can degrade or defer.
 */
export type StageRunner = {
  primaryModelId: string;
  lease(req: StageLeaseRequest): Promise<StageLease>;
};

/** No candidate model's rate-limit window frees up within the allowed wait. */
export class BudgetDeniedError extends Error {
  /** Shortest wait among the candidates; `Infinity` if none will clear. */
  readonly waitMs: number;
  constructor(stage: string, waitMs: number) {
    super(
      Number.isFinite(waitMs)
        ? `Rate limit budget for the ${stage} stage is exhausted; next window in ~${Math.ceil(waitMs / 1_000)}s.`
        : `Rate limit budget for the ${stage} stage is exhausted.`,
    );
    this.name = "BudgetDeniedError";
    this.waitMs = waitMs;
  }
}

export function isBudgetDenied(error: unknown): error is BudgetDeniedError {
  return error instanceof BudgetDeniedError;
}

/**
 * Lease tokens from `stage` and execute a non-retried auxiliary `generateText`
 * call with role-appropriate Groq reasoning settings and timeout.
 */
export async function generateAuxiliaryText(req: {
  stage: StageRunner;
  system: string;
  prompt?: string;
  messages?: ModelMessage[];
  maxOutputTokens: number | ((modelId: string) => number);
  timeoutMs: number;
  maxWaitMs?: number;
  signal?: AbortSignal;
  generateTextImpl?: typeof generateText;
}): Promise<string> {
  const inputPayload = req.prompt ?? JSON.stringify(req.messages ?? []);
  const leased = await req.stage.lease({
    estInputTokens: estimateTokens(req.system) + estimateTokens(inputPayload),
    maxOutputTokens: req.maxOutputTokens,
    maxWaitMs: req.maxWaitMs,
    signal: req.signal,
  });
  const maxOut =
    typeof req.maxOutputTokens === "function"
      ? req.maxOutputTokens(leased.modelId)
      : req.maxOutputTokens;
  const run = req.generateTextImpl ?? generateText;
  const { text } = await run({
    model: leased.model,
    system: req.system,
    ...(req.messages ? { messages: req.messages } : { prompt: req.prompt ?? "" }),
    maxOutputTokens: maxOut,
    providerOptions: groqReasoningOptions(leased.modelId, "auxiliary"),
    ...(req.signal ? { abortSignal: req.signal } : {}),
    timeout: { totalMs: req.timeoutMs },
    maxRetries: 0,
  });
  return text;
}
