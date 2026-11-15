import "server-only";
import type { LanguageModel } from "ai";

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
