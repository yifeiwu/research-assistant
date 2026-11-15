import "server-only";
import { serverConfig } from "@/lib/config";
import { logInfo } from "@/lib/logger";
import type { GroqBudget } from "./groq-budget";
import {
  abortableSleep,
  readCooldowns,
  type GroqCooldownDb,
  type GroqStage,
} from "./groq-rate-limit";

/**
 * Decides, *before* a model call is made, which model a pipeline stage may
 * use and how long it has to wait for that model's per-minute window.
 *
 * Policy (waiting is preferred over degrading, within limits):
 *   1. Use the primary model if it is free, or if waiting for it fits the
 *      stage's wait cap.
 *   2. Otherwise use the first fallback that is free right now.
 *   3. Otherwise wait for whichever candidate frees up soonest, if that fits.
 *   4. Otherwise deny, and the caller degrades (or defers the turn).
 *
 * After every sleep the reservation is re-attempted rather than assumed, with
 * jitter, so turns that waited on the same window do not all fire at once.
 */
export type AcquireRequest = {
  stage: GroqStage;
  /** Model ids in preference order, primary first. */
  candidates: string[];
  estInputTokens: number;
  /** Output reservation, which may differ per model (e.g. Qwen's OTPM cap). */
  maxOutputTokens: number | ((model: string) => number);
  signal?: AbortSignal;
};

export type AcquireGranted = { model: string; waitedMs: number };
export type AcquireDenied = { denied: true; waitMs: number };
export type AcquireResult = AcquireGranted | AcquireDenied;

export function isDenied(result: AcquireResult): result is AcquireDenied {
  return "denied" in result;
}

export interface ModelScheduler {
  acquire(req: AcquireRequest): Promise<AcquireResult>;
}

export type SchedulerStatus =
  | { kind: "waiting"; stage: GroqStage; model: string; resumeAt: number }
  | { kind: "resumed"; stage: GroqStage };

function defaultStageWaitMs(stage: GroqStage): number {
  const waits = serverConfig.groqRateLimit.budgetWait;
  switch (stage) {
    case "synthesis":
      return waits.synthesisMs;
    case "planner":
      return waits.plannerMs;
    case "summary":
      return waits.summaryMs;
  }
}

const JITTER_MIN_MS = 50;
const JITTER_SPREAD_MS = 200;

export function createModelScheduler(opts: {
  budget: GroqBudget;
  /** Per-model 429 cooldowns written by the fetch wrapper (and daily limits). */
  cooldownDb?: () => GroqCooldownDb | undefined;
  onStatus?: (status: SchedulerStatus) => void;
  stageWaitMs?: (stage: GroqStage) => number;
  synthesisReserveTokens?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}): ModelScheduler {
  const nowFn = opts.now ?? Date.now;
  const random = opts.random ?? Math.random;
  const stageWaitMs = opts.stageWaitMs ?? defaultStageWaitMs;
  const reserveTokens =
    opts.synthesisReserveTokens ?? serverConfig.groqRateLimit.synthesisReserveTokens;
  const resolveCooldownDb = opts.cooldownDb ?? (() => undefined);

  const notify = (status: SchedulerStatus) => {
    try {
      opts.onStatus?.(status);
    } catch {
      // Status reporting must never fail a model call.
    }
  };

  return {
    async acquire(req) {
      const started = nowFn();
      const latestStart = started + Math.max(0, stageWaitMs(req.stage));
      const candidates = [...new Set(req.candidates.filter(Boolean))];
      const outputFor = (model: string) =>
        typeof req.maxOutputTokens === "function"
          ? req.maxOutputTokens(model)
          : req.maxOutputTokens;

      let announced = false;
      const settle = <T extends AcquireResult>(result: T): T => {
        if (announced) notify({ kind: "resumed", stage: req.stage });
        return result;
      };

      for (;;) {
        if (req.signal?.aborted) {
          throw new DOMException("The operation was aborted.", "AbortError");
        }
        const now = nowFn();
        const cooldowns = await readCooldowns(candidates, now, resolveCooldownDb);

        let soonest: { model: string; waitMs: number } | undefined;
        for (const [index, model] of candidates.entries()) {
          const cooldown = cooldowns.get(model);
          let waitMs: number;
          if (cooldown) {
            // A daily quota will not clear by waiting; never wait on it.
            waitMs = cooldown.daily
              ? Number.POSITIVE_INFINITY
              : Math.max(0, cooldown.untilMs - now);
          } else {
            const reservation = await opts.budget.reserve(
              model,
              { inputTokens: req.estInputTokens, outputTokens: outputFor(model) },
              {
                // Borrowing another model's window must not starve the turn
                // whose answer depends on it.
                tpmHeadroom: index > 0 && req.stage !== "synthesis" ? reserveTokens : 0,
              },
            );
            if (reservation.granted) {
              const waitedMs = nowFn() - started;
              if (index > 0 || waitedMs > 0) {
                logInfo("groq-schedule", {
                  stage: req.stage,
                  model,
                  primary: candidates[0],
                  waitedMs,
                });
              }
              return settle({ model, waitedMs });
            }
            waitMs = reservation.waitMs;
          }
          if (!soonest || waitMs < soonest.waitMs) soonest = { model, waitMs };
          // Waiting for the primary beats switching model, when it fits.
          if (index === 0 && now + waitMs <= latestStart) break;
        }

        if (!soonest || now + soonest.waitMs > latestStart) {
          const waitMs = soonest?.waitMs ?? Number.POSITIVE_INFINITY;
          logInfo("groq-schedule-denied", {
            stage: req.stage,
            primary: candidates[0],
            waitMs: Number.isFinite(waitMs) ? waitMs : null,
          });
          return settle({ denied: true, waitMs });
        }

        announced = true;
        notify({
          kind: "waiting",
          stage: req.stage,
          model: soonest.model,
          resumeAt: now + soonest.waitMs,
        });
        await abortableSleep(
          soonest.waitMs + JITTER_MIN_MS + Math.floor(random() * JITTER_SPREAD_MS),
          req.signal,
          opts.sleep,
        );
      }
    },
  };
}
