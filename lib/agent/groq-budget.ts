import "server-only";
import { logError } from "@/lib/logger";
import { groqModelLimits, type GroqModelLimits } from "@/lib/models";
import {
  perMinute,
  sharedBucketStore,
  type BucketSpec,
  type BucketStore,
  type ReserveResult,
} from "./token-bucket";

/**
 * Shared per-model Groq token budgets.
 *
 * Groq enforces a combined tokens-per-minute limit (TPM) per model and, on
 * some organisations, separate input (ITPM) and output (OTPM) limits. Its
 * `x-ratelimit-limit-tokens` / `x-ratelimit-remaining-tokens` response
 * headers always describe the combined TPM limit, so only the `tpm` bucket
 * can be corrected from live responses; `itpm` / `otpm` rely on the seed
 * values in `lib/models.ts` and on being emptied when a 429 names them.
 */
export type BudgetDimension = "tpm" | "itpm" | "otpm";

const BUCKET_KEY_PREFIX = "ratelimit:groq:bucket:";

function budgetBucketKey(model: string, dimension: BudgetDimension): string {
  return `${BUCKET_KEY_PREFIX}${model}:${dimension}`;
}

export type BudgetCost = { inputTokens: number; outputTokens: number };

/** What one Groq response told us about a model's limits. */
export type BudgetObservation = {
  /** `x-ratelimit-limit-tokens` (combined TPM). */
  limitTokens?: number;
  /** `x-ratelimit-remaining-tokens` (combined TPM). */
  remainingTokens?: number;
  /** The window a 429 said was exhausted. */
  exhausted?: BudgetDimension;
};

export type GroqBudget = {
  limitsFor(model: string): GroqModelLimits | undefined;
  /**
   * Reserve tokens for one call. Models with no known limit are unbudgeted
   * and always granted. `tpmHeadroom` requires that much TPM to stay free.
   */
  reserve(
    model: string,
    cost: BudgetCost,
    opts?: { tpmHeadroom?: number },
  ): Promise<ReserveResult>;
  /** Fold a response's rate-limit headers back into the buckets. Never throws. */
  observe(model: string, observation: BudgetObservation): Promise<void>;
};

export function createGroqBudget(opts?: {
  store?: BucketStore;
  now?: () => number;
  seedLimits?: (model: string) => GroqModelLimits | undefined;
}): GroqBudget {
  const resolveStore = () => opts?.store ?? sharedBucketStore();
  const nowFn = opts?.now ?? Date.now;
  const seedLimits = opts?.seedLimits ?? groqModelLimits;
  // Combined TPM learned from response headers. It overrides the seed, so a
  // plan change (or a wrong seed) corrects itself after the first response.
  const learnedTpm = new Map<string, number>();

  const limitsFor = (model: string): GroqModelLimits | undefined => {
    const seed = seedLimits(model);
    const tpm = learnedTpm.get(model) ?? seed?.tpm;
    if (tpm == null && seed?.itpm == null && seed?.otpm == null) return undefined;
    return { ...seed, ...(tpm != null ? { tpm } : {}) };
  };

  return {
    limitsFor,
    async reserve(model, cost, reserveOpts) {
      const limits = limitsFor(model);
      if (!limits) return { granted: true, waitMs: 0 };

      const input = Math.max(0, Math.ceil(cost.inputTokens));
      const output = Math.max(0, Math.ceil(cost.outputTokens));
      const buckets: BucketSpec[] = [];
      if (limits.tpm) {
        buckets.push({
          key: budgetBucketKey(model, "tpm"),
          cost: input + output,
          headroom: reserveOpts?.tpmHeadroom ?? 0,
          ...perMinute(limits.tpm),
        });
      }
      if (limits.itpm) {
        buckets.push({
          key: budgetBucketKey(model, "itpm"),
          cost: input,
          ...perMinute(limits.itpm),
        });
      }
      if (limits.otpm) {
        buckets.push({
          key: budgetBucketKey(model, "otpm"),
          cost: output,
          ...perMinute(limits.otpm),
        });
      }
      if (buckets.length === 0) return { granted: true, waitMs: 0 };

      try {
        return await resolveStore().reserve(buckets, nowFn());
      } catch (error) {
        logError("groq-budget-reserve", error, { model });
        return { granted: true, waitMs: 0 };
      }
    },
    async observe(model, observation) {
      try {
        const { limitTokens, remainingTokens, exhausted } = observation;
        if (limitTokens != null && Number.isFinite(limitTokens) && limitTokens > 0) {
          learnedTpm.set(model, limitTokens);
        }
        const limits = limitsFor(model);
        if (!limits) return;
        const store = resolveStore();
        const now = nowFn();

        if (
          limits.tpm &&
          remainingTokens != null &&
          Number.isFinite(remainingTokens)
        ) {
          await store.clamp(
            { key: budgetBucketKey(model, "tpm"), ...perMinute(limits.tpm) },
            remainingTokens,
            now,
          );
        }
        const exhaustedLimit = exhausted ? limits[exhausted] : undefined;
        if (exhausted && exhaustedLimit) {
          await store.clamp(
            { key: budgetBucketKey(model, exhausted), ...perMinute(exhaustedLimit) },
            0,
            now,
          );
        }
      } catch (error) {
        logError("groq-budget-observe", error, { model });
      }
    },
  };
}

let shared: GroqBudget | undefined;

/** Process-wide budget (keeps limits learned from headers across requests). */
export function sharedGroqBudget(): GroqBudget {
  shared ??= createGroqBudget();
  return shared;
}
