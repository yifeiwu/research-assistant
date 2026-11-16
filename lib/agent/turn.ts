import "server-only";
import {
  generateText,
  streamText,
  type ModelMessage,
  type UIMessageStreamWriter,
} from "ai";
import { createAbortError, isAbortError } from "@/lib/errors";
import { serverConfig } from "@/lib/config";
import type { EffortConfig } from "@/lib/effort";
import { logError, logInfo } from "@/lib/logger";
import {
  groqModelLabel,
  groqReasoningOptions,
  maxSummaryOutputTokens,
  maxSynthesisOutputTokens,
} from "@/lib/models";
import { stripThinking } from "@/lib/pipeline";
import {
  buildAnalyticalBlueprintPrompt,
  buildDirectAnswerPrompt,
  buildSynthesisPrompt,
} from "@/lib/prompts";
import { runResearchPipeline, type ResearchOutcome } from "@/lib/research";
import { estimateTokens } from "@/lib/tokens";
import type {
  ChatUIMessage,
  ResearchSource,
  TurnStatusData,
} from "@/lib/types/chat";
import {
  AdmissionBusyError,
  type AdmissionQueue,
  type AdmissionTicket,
} from "./admission";
import { TurnDeferredError } from "./defer";
import type { GroqStage } from "./groq-rate-limit";
import {
  isResolutionError,
  resolveModels,
  type ModelResolutionError,
} from "./models";
import { generateAuxiliaryText, isBudgetDenied, type StageLease } from "./stage";
import {
  createPipelineStream,
  type PipelineStream,
  type StreamResult,
} from "./stream";

/** Work a later attempt of the same turn can skip. */
export type TurnCheckpoint = {
  outcome: ResearchOutcome;
  /** Pre-verified analytical blueprint computed before synthesis on high effort. */
  analyticalBlueprint?: string;
  /** How long the turn waited for its research slot (ms), for its summary. */
  queueWaitMs?: number;
};

/**
 * What an attempt learned about its turn, for the turn's summary log line
 * (lib/agent/detached.ts). Filled in as the attempt runs, and complete once
 * its stream has closed. Times are epoch ms.
 */
export type TurnStats = {
  /** Time spent waiting for a research slot (ms). */
  queueWaitMs?: number;
  /** Present once research is done, in this attempt or an earlier one. */
  research?: {
    searched: boolean;
    sources: number;
    degraded: boolean;
    stages?: ResearchOutcome["stats"];
  };
  /** Present once the answer was started. */
  answer?: {
    model: string;
    startedAt: number;
    firstTextAt?: number;
    endedAt?: number;
    finishReason?: string;
    usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
  };
  /** The attempt ended in an error that was shown to the user. */
  failed?: boolean;
};

/** One attempt at a turn: its output, and what it learned on the way. */
export type TurnAttempt = PipelineStream & { stats: TurnStats };

export type TurnAdmission = {
  queue: AdmissionQueue;
  ticket: AdmissionTicket;
  /**
   * When the turn is still in line, keep its place and defer for this long
   * before looking again. Left unset once the turn has queued for too long,
   * so it fails as busy instead.
   */
  deferDelayMs?: number;
};

export type TurnInput = {
  requestId: string;
  requestedModel?: string;
  query: string;
  effort: EffortConfig;
  modelMessages: ModelMessage[];
  signal: AbortSignal;
  /**
   * Omitted for turns that need no research slot (direct answers). Not
   * consulted when `checkpoint` is set: the research is already done.
   */
  admission?: TurnAdmission;
  /** False when continuing a stream an earlier attempt already opened. */
  emitStart: boolean;
  /** Research already completed by an earlier attempt. */
  checkpoint?: TurnCheckpoint;
  saveCheckpoint: (checkpoint: TurnCheckpoint) => Promise<void>;
  /**
   * Longest rate-limit wait the turn may defer for, rather than sending the
   * answer into a window that is known to be full.
   */
  maxDeferMs: number;
  /**
   * The latest the answer may start in this invocation. Past it the turn
   * defers instead, so the answer is not cut off by the function's time
   * limit part-way, which cannot be retried.
   */
  answerBy: number;
  /**
   * When the answer has to be complete in this invocation. It streams with
   * the time left until then as its timeout, so that it ends with an error
   * the user sees rather than by the function being killed.
   */
  finishBy: number;
  deps?: Partial<TurnDeps>;
};

type TurnDeps = {
  resolveModels: typeof resolveModels;
  runResearch: typeof runResearchPipeline;
  generateText: typeof generateText;
  streamText: typeof streamText;
  now: () => number;
};

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw createAbortError();
  }
}

const STATUS_STAGE: Record<GroqStage, "planning" | "reading" | "answering"> = {
  planner: "planning",
  summary: "reading",
  synthesis: "answering",
};

/**
 * One attempt at a chat turn: (take a research slot) -> research ->
 * streamed answer. Run by lib/agent/detached.ts.
 *
 * Returns the attempt's output stream straight away; the work has started
 * and writes into it. An attempt that cannot finish the turn now defers it
 * instead (see `PipelineStream.deferral`): it is still queued, the answer's
 * model has no room yet, or the invocation is too old to start the answer.
 * A later attempt continues from the research checkpoint.
 */
export function startTurn(input: TurnInput): TurnAttempt | ModelResolutionError {
  const { requestId, signal } = input;
  const stats: TurnStats = { queueWaitMs: input.checkpoint?.queueWaitMs };
  const admission = input.checkpoint ? undefined : input.admission;
  const deps: TurnDeps = {
    resolveModels,
    runResearch: runResearchPipeline,
    generateText,
    streamText,
    now: Date.now,
    ...input.deps,
  };

  let activeWriter: UIMessageStreamWriter<ChatUIMessage> | undefined;
  let activeModelId = "";
  let statusShown = !input.emitStart;

  const writeStatus = (data: TurnStatusData) => {
    if (data.state === "clear" && !statusShown) return;
    statusShown = data.state !== "clear";
    try {
      activeWriter?.write({
        type: "data-turn-status",
        id: `turn-status-${requestId}`,
        data,
      });
    } catch {
      // A closed stream must not fail the work reporting on it.
    }
  };

  const resolved = deps.resolveModels({
    model: input.requestedModel,
    onSynthesisFallback: (event) => {
      activeModelId = event.to;
      activeWriter?.write({
        type: "data-model-fallback",
        id: `model-fallback-${requestId}`,
        data: {
          fromModel: event.from,
          toModel: event.to,
          fromLabel: groqModelLabel(event.from),
          toLabel: groqModelLabel(event.to),
        },
      });
    },
    onStatus: (status) => {
      if (status.kind === "resumed") {
        writeStatus({ state: "clear" });
        return;
      }
      writeStatus({
        state: "waiting",
        stage: STATUS_STAGE[status.stage],
        modelLabel: groqModelLabel(status.model),
        resumeAt: status.resumeAt,
      });
    },
  });
  if (isResolutionError(resolved)) return resolved;
  activeModelId = resolved.selectedModel;

  let allowedSources: ResearchSource[] = [];
  let releaseSlot: (() => Promise<void>) | undefined;
  const isDeep = input.effort.deep;

  const execute = async (
    writer: UIMessageStreamWriter<ChatUIMessage>,
  ): Promise<StreamResult> => {
    activeWriter = writer;
    throwIfAborted(signal);

    if (admission) {
      const state = await admission.queue.poll(admission.ticket);
      if (state.state === "queued" && admission.deferDelayMs != null) {
        writeStatus({ state: "queued", position: state.position });
        throw new TurnDeferredError("queued", admission.deferDelayMs);
      }
      if (state.state !== "granted") throw new AdmissionBusyError();
      releaseSlot = admission.queue.hold(admission.ticket);
      stats.queueWaitMs = Math.max(0, deps.now() - admission.ticket.enqueuedAt);
    }
    writeStatus({ state: "clear" });

    let outcome: ResearchOutcome;
    if (input.checkpoint) {
      outcome = input.checkpoint.outcome;
    } else {
      outcome = await deps.runResearch({
        messages: input.modelMessages,
        query: input.query,
        effort: input.effort,
        stages: resolved.stages,
        writer,
        signal,
        requestId,
      });
      try {
        await input.saveCheckpoint({ outcome, queueWaitMs: stats.queueWaitMs });
      } catch (error) {
        logError("turn-checkpoint", error, { requestId });
      }
    }
    stats.research = {
      searched: outcome.searched,
      sources: outcome.totalSources,
      degraded: Boolean(outcome.degraded),
      stages: outcome.stats,
    };
    allowedSources = outcome.sources;
    throwIfAborted(signal);

    if (deps.now() > input.answerBy) {
      throw new TurnDeferredError("handoff", 0);
    }

    // On deep high-effort turns with multiple corroborated sources, run a compact
    // Analytical Blueprint & Entailment Critic pass on the independent planner
    // model bucket before streaming prose.
    let analyticalBlueprint = input.checkpoint?.analyticalBlueprint;
    if (
      !analyticalBlueprint &&
      isDeep &&
      outcome.searched &&
      outcome.totalSources >= 2 &&
      input.finishBy - deps.now() >= serverConfig.blueprint.minRemainingWindowMs
    ) {
      try {
        const blueprintText = await generateAuxiliaryText({
          stage: resolved.stages.planner,
          system: buildAnalyticalBlueprintPrompt(),
          prompt: `User question:\n${input.query}\n\nGathered research notes:\n${outcome.evidenceBlock}\n\nProduce the 4-part verification blueprint:`,
          maxOutputTokens: (modelId) =>
            Math.min(
              serverConfig.blueprint.maxOutputTokens,
              maxSummaryOutputTokens(modelId, serverConfig.blueprint.maxOutputTokens),
            ),
          timeoutMs: serverConfig.blueprint.timeoutMs,
          maxWaitMs: serverConfig.groqRateLimit.deepBudgetWait.plannerMs,
          signal,
          generateTextImpl: deps.generateText,
        });
        const cleanedBlueprint = stripThinking(blueprintText).slice(
          0,
          serverConfig.blueprint.maxInjectedChars,
        );
        if (cleanedBlueprint.length >= 40) {
          analyticalBlueprint = cleanedBlueprint;
          try {
            await input.saveCheckpoint({
              outcome,
              analyticalBlueprint,
              queueWaitMs: stats.queueWaitMs,
            });
          } catch (error) {
            logError("turn-checkpoint", error, { requestId });
          }
        }
      } catch (error) {
        if (isAbortError(error) || signal.aborted) throw error;
        logInfo("synthesis-blueprint-skipped", {
          requestId,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
      throwIfAborted(signal);
    }

    const outputTokensFor = (modelId: string) =>
      maxSynthesisOutputTokens(modelId, serverConfig.synthesis.maxOutputTokens);
    const buildSystemFor = (modelId: string) => {
      if (!outcome.searched) {
        return buildDirectAnswerPrompt(outcome.degraded, outcome.searchFailed);
      }
      const modelCap = outputTokensFor(modelId);
      return buildSynthesisPrompt(outcome.evidenceBlock, outcome.degraded, {
        effort: input.effort.level,
        maxOutputTokens: modelCap,
        analyticalBlueprint: modelCap >= 1_500 ? analyticalBlueprint : undefined,
      });
    };
    const initialSystem = buildSystemFor(resolved.selectedModel);

    let leased: StageLease;
    try {
      leased = await resolved.stages.synthesis.lease({
        estInputTokens:
          estimateTokens(initialSystem) + estimateTokens(JSON.stringify(input.modelMessages)),
        maxOutputTokens: outputTokensFor,
        maxWaitMs: isDeep
          ? serverConfig.groqRateLimit.deepBudgetWait.synthesisMs
          : undefined,
        signal,
      });
    } catch (error) {
      if (!isBudgetDenied(error)) throw error;
      if (error.waitMs <= input.maxDeferMs) {
        writeStatus({
          state: "waiting",
          stage: "answering",
          modelLabel: groqModelLabel(resolved.selectedModel),
          resumeAt: deps.now() + error.waitMs,
        });
        throw new TurnDeferredError("rate-limit", error.waitMs + 1_000);
      }
      logInfo("synthesis-unbudgeted", { requestId, waitMs: error.waitMs });
      leased = {
        model: resolved.mainModel,
        modelId: resolved.selectedModel,
        waitedMs: 0,
      };
    }
    activeModelId = leased.modelId;
    const system =
      leased.modelId === resolved.selectedModel
        ? initialSystem
        : buildSystemFor(leased.modelId);

    const answerWindowMs = input.finishBy - deps.now();
    if (answerWindowMs < serverConfig.synthesis.minWindowMs) {
      throw new TurnDeferredError("handoff", 0);
    }

    const answer: NonNullable<TurnStats["answer"]> = {
      model: leased.modelId,
      startedAt: deps.now(),
    };
    stats.answer = answer;

    return deps.streamText({
      model: leased.model,
      system,
      messages: input.modelMessages,
      providerOptions: groqReasoningOptions(
        leased.modelId,
        "synthesis",
        input.effort.level,
      ),
      maxOutputTokens: outputTokensFor(leased.modelId),
      maxRetries: 0,
      timeout: {
        totalMs: Math.min(serverConfig.synthesis.totalTimeoutMs, answerWindowMs),
        stepMs: Math.min(serverConfig.synthesis.stepTimeoutMs, answerWindowMs),
      },
      abortSignal: signal,
      onAbort: () => {
        logInfo("abort", { requestId, model: activeModelId });
      },
      onError: ({ error }) => {
        logError("streamText", error, { requestId, model: activeModelId });
      },
      onFinish: ({ finishReason, usage }) => {
        answer.endedAt = deps.now();
        answer.finishReason = finishReason;
        answer.usage = {
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          totalTokens: usage.totalTokens,
        };
        logInfo("finish", {
          requestId,
          model: activeModelId,
          finishReason,
          searched: outcome.searched,
          sources: outcome.totalSources,
          usage,
        });
      },
    }) as StreamResult;
  };

  const pipeline = createPipelineStream(execute, {
    requestId,
    modelId: () => activeModelId,
    signal,
    getAllowedSources: () => allowedSources,
    emitStart: input.emitStart,
    onSettled: async (deferral) => {
      if (releaseSlot) {
        await releaseSlot();
      } else if (admission && !deferral) {
        await admission.queue.cancel(admission.ticket);
      }
    },
    onAnswerText: () => {
      if (stats.answer) stats.answer.firstTextAt ??= deps.now();
    },
    onFailed: () => {
      stats.failed = true;
    },
  });
  return { ...pipeline, stats };
}
