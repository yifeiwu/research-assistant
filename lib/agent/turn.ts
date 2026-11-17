import "server-only";
import {
  APICallError,
  RetryError,
  generateText,
  type FinishReason,
  type ModelMessage,
} from "ai";
import { verifyCitations } from "@/lib/citations";
import { serverConfig } from "@/lib/config";
import type { EffortConfig } from "@/lib/effort";
import { createAbortError } from "@/lib/errors";
import { logInfo } from "@/lib/logger";
import {
  fitSynthesisOutputTokens,
  groqReasoningOptions,
  maxSynthesisOutputTokens,
} from "@/lib/models";
import { stripThinking } from "@/lib/pipeline";
import {
  buildDirectAnswerPrompt,
  buildSynthesisPrompt,
} from "@/lib/prompts";
import { runResearchPipeline, type ResearchOutcome } from "@/lib/research";
import { normalizeUrlKey, splitSourcesByCitation } from "@/lib/sources";
import { estimateTokens } from "@/lib/tokens";
import type {
  ChatMessage,
  ResearchSource,
  ResearchStepData,
  TurnWaitState,
} from "@/lib/types/chat";
import type { GroqStage } from "./groq-rate-limit";
import {
  isResolutionError,
  resolveModels,
  type ModelResolutionError,
} from "./models";
import { QueueBusyError } from "./queue";

function rootError(error: unknown): unknown {
  return RetryError.isInstance(error) ? error.lastError : error;
}

function rateLimitMessage(error: unknown): string | undefined {
  const root = rootError(error);
  const rawMessage =
    root instanceof Error ? root.message : typeof root === "string" ? root : "";

  const isRateLimit =
    (APICallError.isInstance(root) && root.statusCode === 429) ||
    /rate limit reached|rate limit exceeded|too many requests/i.test(rawMessage);
  if (!isRateLimit) return undefined;

  const retryIn = rawMessage.match(
    /try again in ((?:\d[\d.]*(?:ms|[hms]))+)/i,
  )?.[1];
  const waitHint = retryIn
    ? ` Please try again in about ${retryIn}.`
    : " Please wait a moment and try again.";

  return `You've hit the model rate limit.${waitHint}`;
}

function isTimeoutError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.name === "TimeoutError" || /timed? ?out/i.test(error.message);
}

/**
 * Sanitize provider/server errors into safe, actionable user messages without
 * leaking org IDs, raw provider payloads, or prompt text.
 */
export function clientErrorMessage(error: unknown, requestId: string): string {
  const rateLimited = rateLimitMessage(error);
  if (rateLimited) return rateLimited;

  const root = rootError(error);
  if (root instanceof QueueBusyError) return root.message;

  if (APICallError.isInstance(root) && root.statusCode != null) {
    const status = root.statusCode;
    if (status === 401 || status === 403) {
      return `The model provider rejected the server's API key (HTTP ${status}).`;
    }
    if (status === 404) {
      return "A configured model is not available at the provider (HTTP 404).";
    }
    if (status === 413) {
      return "The request was too large for the model (HTTP 413).";
    }
    if (status >= 500) {
      return `The model provider had a server error (HTTP ${status}).`;
    }
    return `The model provider rejected the request (HTTP ${status}).`;
  }

  if (isTimeoutError(root)) {
    return "The model took too long to respond, and the request timed out.";
  }
  return `Something went wrong on the server while answering (reference ${requestId}).`;
}

function noAnswerMessage(finishReason: FinishReason | string | undefined): string {
  switch (finishReason) {
    case "length":
      return "I ran out of output space before I could finish answering. This can happen when a reasoning model spends its whole token budget thinking. Please try again.";
    case "content-filter":
      return "The response was blocked by the model's content filter before an answer could be produced. Try rephrasing your question.";
    default:
      return "I finished without producing an answer. This can happen intermittently — try sending the message again.";
  }
}

export type TurnDeps = {
  resolveModels: typeof resolveModels;
  runResearch: typeof runResearchPipeline;
  generateText: typeof generateText;
};

export type ExecuteTurnInput = {
  requestId: string;
  query: string;
  effort: EffortConfig;
  modelMessages: ModelMessage[];
  /** Sources retrieved in earlier turns of the same thread (valid for follow-up citations). */
  priorSources?: ResearchSource[];
  signal: AbortSignal;
  deadlineAt?: number;
  onProgress?: (progress: {
    steps: ResearchStepData[];
    sources: ResearchSource[];
  }) => void | Promise<void>;
  onWait?: (wait: TurnWaitState | null) => void | Promise<void>;
  deps?: Partial<TurnDeps>;
};

export type ExecuteTurnResult = {
  message: ChatMessage;
  steps: ResearchStepData[];
  sources: ResearchSource[];
};

const WAIT_STAGE_MAP: Record<GroqStage, "planning" | "reading" | "answering"> = {
  planner: "planning",
  summary: "reading",
  synthesis: "answering",
};

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw createAbortError();
}

/**
 * Execute one complete turn (sequential Exa research + single-pass synthesis +
 * citation verification) and return the durable assistant `ChatMessage`.
 */
export async function executeTurn(
  input: ExecuteTurnInput,
): Promise<ExecuteTurnResult | ModelResolutionError> {
  const { requestId, signal } = input;
  const deps: TurnDeps = {
    resolveModels,
    runResearch: runResearchPipeline,
    generateText,
    ...input.deps,
  };

  const resolved = deps.resolveModels({
    deadlineAt: input.deadlineAt,
    onWait: (stage, resumeAt) =>
      input.onWait?.(
        resumeAt == null
          ? null
          : {
              kind: "rate-limit",
              stage: WAIT_STAGE_MAP[stage],
              resumeAt,
            },
      ),
  });
  if (isResolutionError(resolved)) return resolved;

  throwIfAborted(signal);

  const outcome: ResearchOutcome = await deps.runResearch({
    messages: input.modelMessages,
    query: input.query,
    effort: input.effort,
    stages: resolved.stages,
    onProgress: input.onProgress,
    signal,
    deadlineAt: input.deadlineAt,
    requestId,
  });

  throwIfAborted(signal);

  const baseOutputCap = (modelId: string) =>
    maxSynthesisOutputTokens(modelId, serverConfig.synthesis.maxOutputTokens);
  const buildSystemFor = (modelId: string) =>
    outcome.searched
      ? buildSynthesisPrompt(outcome.evidenceBlock, outcome.degraded, {
          effort: input.effort.level,
          maxOutputTokens: baseOutputCap(modelId),
        })
      : buildDirectAnswerPrompt(outcome.degraded, outcome.searchFailed);
  const historyTokens = estimateTokens(JSON.stringify(input.modelMessages));
  const inputTokensFor = (modelId: string) =>
    estimateTokens(buildSystemFor(modelId)) + historyTokens;
  const outputTokensFor = (modelId: string) =>
    fitSynthesisOutputTokens(
      modelId,
      inputTokensFor(modelId),
      serverConfig.synthesis.maxOutputTokens,
    );

  const leased = await resolved.stages.synthesis.lease({
    estInputTokens: inputTokensFor,
    maxOutputTokens: outputTokensFor,
    signal,
  });

  const maxOut = outputTokensFor(leased.modelId);
  const system = buildSystemFor(leased.modelId);
  const remainingMs =
    input.deadlineAt != null
      ? Math.max(15_000, input.deadlineAt - Date.now())
      : serverConfig.synthesis.totalTimeoutMs;

  const result = await deps.generateText({
    model: leased.model,
    system,
    messages: input.modelMessages,
    providerOptions: groqReasoningOptions(
      leased.modelId,
      "synthesis",
      input.effort.level,
    ),
    maxOutputTokens: maxOut,
    maxRetries: 0,
    timeout: {
      totalMs: Math.min(serverConfig.synthesis.totalTimeoutMs, remainingMs),
    },
    abortSignal: signal,
  });

  const cleanedText = stripThinking(result.text);
  const allowedSources = [
    ...outcome.sources,
    ...(input.priorSources ?? []),
  ];
  const verified = verifyCitations(cleanedText, allowedSources);
  if (verified.strippedCount > 0) {
    logInfo("citation-verification", {
      requestId,
      stripped: verified.strippedCount,
    });
  }

  const trimmedVerified = verified.text.trim();
  const truncatedByLength =
    result.finishReason === "length" && trimmedVerified.length > 0;
  const finalText = trimmedVerified
    ? truncatedByLength
      ? `${verified.text.trimEnd()}\n\n---\n_Note: This response reached the model's single-turn output token limit and was cut short._`
      : verified.text
    : noAnswerMessage(result.finishReason);
  const reasoning = result.reasoningText?.trim() || undefined;

  // Include current-turn sources plus any prior-turn sources explicitly cited in this answer.
  const currentSourceKeys = new Set(
    outcome.sources.map((s) => normalizeUrlKey(s.url)),
  );
  const citedPrior = (input.priorSources ?? []).length > 0
    ? splitSourcesByCitation(
        { text: finalText },
        (input.priorSources ?? []).filter(
          (s) => !currentSourceKeys.has(normalizeUrlKey(s.url)),
        ),
      ).cited
    : [];
  const mergedSources = [...outcome.sources, ...citedPrior].slice(0, 60);

  logInfo("finish", {
    requestId,
    model: leased.modelId,
    finishReason: result.finishReason,
    searched: outcome.searched,
    sources: mergedSources.length,
    usage: result.usage,
  });

  const message: ChatMessage = {
    id: `msg-${requestId}`,
    role: "assistant",
    text: finalText,
    ...(reasoning ? { reasoning } : {}),
    ...(outcome.steps.length > 0 ? { steps: outcome.steps } : {}),
    ...(mergedSources.length > 0 ? { sources: mergedSources } : {}),
  };

  return {
    message,
    steps: outcome.steps,
    sources: mergedSources,
  };
}
