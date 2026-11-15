import "server-only";
import {
  streamText,
  type ModelMessage,
  type UIMessageStreamWriter,
} from "ai";
import { serverConfig } from "@/lib/config";
import type { EffortConfig } from "@/lib/effort";
import { logError, logInfo } from "@/lib/logger";
import {
  groqModelLabel,
  groqReasoningOptions,
  maxSynthesisOutputTokens,
} from "@/lib/models";
import { buildDirectAnswerPrompt, buildSynthesisPrompt } from "@/lib/prompts";
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
import { isBudgetDenied, type StageLease } from "./stage";
import {
  createPipelineStream,
  type PipelineStream,
  type StreamResult,
} from "./stream";

/** Work a later attempt of the same turn can skip. */
export type TurnCheckpoint = {
  outcome: ResearchOutcome;
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
  /** Conversation id; searches are limited to 2 in parallel per thread. */
  threadId: string;
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
  streamText: typeof streamText;
  now: () => number;
};

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new DOMException("The operation was aborted.", "AbortError");
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
  // The queue rations research. A turn that already has its research gave
  // its slot back when the earlier attempt deferred, and must not line up
  // (or be turned away by a full queue) a second time just to answer: the
  // model budgets pace the answer on their own.
  const admission = input.checkpoint ? undefined : input.admission;
  const deps: TurnDeps = {
    resolveModels,
    runResearch: runResearchPipeline,
    streamText,
    now: Date.now,
    ...input.deps,
  };

  let activeWriter: UIMessageStreamWriter<ChatUIMessage> | undefined;
  let activeModelInfo = "";
  // A continued turn may still be showing an earlier attempt's status.
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
      activeModelInfo = `groq ${event.to}`;
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
  activeModelInfo = resolved.modelInfo;

  let allowedSources: ResearchSource[] = [];
  let releaseSlot: (() => Promise<void>) | undefined;

  const execute = async (
    writer: UIMessageStreamWriter<ChatUIMessage>,
  ): Promise<StreamResult> => {
    activeWriter = writer;
    throwIfAborted(signal);

    if (admission) {
      const state = await admission.queue.poll(admission.ticket);
      if (state.state === "queued" && admission.deferDelayMs != null) {
        // Still in line. Show the position and look again in a later attempt.
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
        threadId: input.threadId,
      });
      try {
        await input.saveCheckpoint({ outcome, queueWaitMs: stats.queueWaitMs });
      } catch (error) {
        // Only costs a repeat of (cached) research if this attempt dies.
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
    // Stopped during research (or before a resumed attempt got this far).
    throwIfAborted(signal);

    // Too late to start the answer here. Research is checkpointed, so a
    // fresh invocation can go straight to it.
    if (deps.now() > input.answerBy) {
      throw new TurnDeferredError("handoff", 0);
    }

    // Bounded per-model output reservation (e.g. 900 on Qwen's 1k OTPM
    // bucket, 3,500 on GPT-OSS).
    const outputTokensFor = (modelId: string) =>
      maxSynthesisOutputTokens(modelId, serverConfig.synthesis.maxOutputTokens);
    const buildSystemFor = (modelId: string) =>
      outcome.searched
        ? buildSynthesisPrompt(outcome.evidenceBlock, outcome.degraded, {
            effort: input.effort.level,
            maxOutputTokens: outputTokensFor(modelId),
          })
        : buildDirectAnswerPrompt(outcome.degraded, outcome.searchFailed);
    const initialSystem = buildSystemFor(resolved.selectedModel);

    let leased: StageLease;
    try {
      leased = await resolved.stages.synthesis.lease({
        estInputTokens:
          estimateTokens(initialSystem) + estimateTokens(JSON.stringify(input.modelMessages)),
        maxOutputTokens: outputTokensFor,
        signal,
      });
    } catch (error) {
      if (!isBudgetDenied(error)) throw error;
      if (error.waitMs <= input.maxDeferMs) {
        // Come back when the window has room. Research is checkpointed,
        // so the next attempt goes straight to the answer.
        writeStatus({
          state: "waiting",
          stage: "answering",
          modelLabel: groqModelLabel(resolved.selectedModel),
          resumeAt: deps.now() + error.waitMs,
        });
        throw new TurnDeferredError("rate-limit", error.waitMs + 1_000);
      }
      // The window is too far away to defer for, or will not reopen (a
      // daily limit). Send the request anyway: the fetch wrapper still
      // handles a 429 reactively (short sleep or fallback).
      logInfo("synthesis-unbudgeted", { requestId, waitMs: error.waitMs });
      leased = {
        model: resolved.mainModel,
        modelId: resolved.selectedModel,
        waitedMs: 0,
      };
    }
    activeModelInfo = `groq ${leased.modelId}`;
    const system =
      leased.modelId === resolved.selectedModel
        ? initialSystem
        : buildSystemFor(leased.modelId);

    // The wait for the model's window may have used up the time the answer
    // was going to have. Research is checkpointed, so hand the turn over.
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
      // Waiting and model choice are owned by the scheduler, and surprise
      // 429s by `createResilientGroqFetch`, so AI SDK blind retries are
      // disabled.
      maxOutputTokens: outputTokensFor(leased.modelId),
      maxRetries: 0,
      timeout: {
        totalMs: Math.min(serverConfig.synthesis.totalTimeoutMs, answerWindowMs),
        stepMs: Math.min(serverConfig.synthesis.stepTimeoutMs, answerWindowMs),
      },
      abortSignal: signal,
      onAbort: () => {
        logInfo("abort", { requestId, model: activeModelInfo });
      },
      onError: ({ error }) => {
        logError("streamText", error, { requestId, model: activeModelInfo });
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
          model: activeModelInfo,
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
    modelInfo: () => activeModelInfo,
    signal,
    getAllowedSources: () => allowedSources,
    emitStart: input.emitStart,
    onSettled: async (deferral) => {
      if (releaseSlot) {
        // Held a slot: free it, whether the turn finished or deferred.
        await releaseSlot();
      } else if (admission && !deferral) {
        // Never got a slot and is not coming back: leave the queue.
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
