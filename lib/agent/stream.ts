import "server-only";
import { isAbortError } from "@/lib/errors";
import {
  APICallError,
  RetryError,
  createUIMessageStream,
  streamText,
  type FinishReason,
  type InferUIMessageChunk,
  type UIMessageStreamWriter,
} from "ai";
import { logInfo, logError } from "@/lib/logger";
import { groqModelLabel } from "@/lib/models";
import { verifyCitations } from "@/lib/citations";
import type { ChatUIMessage, ResearchSource } from "@/lib/types/chat";
import { AdmissionBusyError } from "./admission";
import { isTurnDeferred, type TurnDeferredError } from "./defer";

/** The parts of a `streamText` result this module consumes. */
export type StreamResult = Pick<
  ReturnType<typeof streamText>,
  "toUIMessageStream" | "finishReason"
>;

export type ChatChunk = InferUIMessageChunk<ChatUIMessage>;

/** One attempt's output. */
export type PipelineStream = {
  stream: ReadableStream<ChatChunk>;
  /**
   * Settles once `stream` has closed, with the deferral if the turn was
   * left for a later attempt. The stream then holds no `finish`, `abort` or
   * `error`, so a later attempt can append to it.
   */
  deferral: Promise<TurnDeferredError | undefined>;
};

/**
 * Unwrap the most relevant underlying error. `streamText` retries transient
 * failures and, when they all fail, surfaces a `RetryError` whose `lastError`
 * holds the actual provider error (e.g. the 429 from Groq).
 */
function rootError(error: unknown): unknown {
  return RetryError.isInstance(error) ? error.lastError : error;
}

/**
 * Detect a provider rate-limit (HTTP 429 / "rate limit reached") and, if found,
 * return a friendly message that tells the user to wait or switch models. The
 * raw provider text leaks internal org ids and upgrade URLs, so we never show it
 * verbatim. Returns `undefined` when the error isn't a rate limit.
 */
function rateLimitMessage(
  error: unknown,
  modelInfo?: string,
): string | undefined {
  const root = rootError(error);
  const rawMessage =
    root instanceof Error ? root.message : typeof root === "string" ? root : "";

  const isRateLimit =
    (APICallError.isInstance(root) && root.statusCode === 429) ||
    /rate limit reached|rate limit exceeded|too many requests/i.test(rawMessage);
  if (!isRateLimit) return undefined;

  const idFromInfo = modelInfo?.replace(/^groq\s+/, "");
  const idFromMessage = rawMessage.match(/model `([^`]+)`/)?.[1];
  const label = groqModelLabel(idFromInfo ?? idFromMessage);

  // Only a duration is taken from the provider's text ("7.66s", "1m30s").
  const retryIn = rawMessage.match(
    /try again in ((?:\d[\d.]*(?:ms|[hms]))+)/i,
  )?.[1];
  const waitHint = retryIn
    ? ` You can try again in about ${retryIn}, or`
    : " You can wait a bit, or";

  return (
    `You've hit the rate limit for ${label}.` +
    `${waitHint} switch to a different model in Settings and send your message again.`
  );
}

function isTimeoutError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.name === "TimeoutError" || /timed? ?out/i.test(error.message);
}

/**
 * What the user is told about a failed turn: one of a fixed set of messages,
 * chosen by the kind of failure. An error's own text is never passed on,
 * because a provider's can carry org ids, request details and model output;
 * it goes to the server log, which the reference in the catch-all message
 * leads back to.
 *
 * The wording is what lib/chat-error.ts keys its explanations on (status
 * codes, "timed out", "rate limit"); tests/stream.test.ts holds the two
 * together.
 */
function clientErrorMessage(
  error: unknown,
  ctx: { requestId: string; modelInfo?: string },
): string {
  const rateLimited = rateLimitMessage(error, ctx.modelInfo);
  if (rateLimited) return rateLimited;

  const root = rootError(error);
  // Written for the user in the first place.
  if (root instanceof AdmissionBusyError) return root.message;

  if (APICallError.isInstance(root) && root.statusCode != null) {
    const status = root.statusCode;
    if (status === 401 || status === 403) {
      return `The model provider rejected the server's API key (HTTP ${status}).`;
    }
    if (status === 404) {
      return "The selected model is not available at the provider (HTTP 404).";
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
  return `Something went wrong on the server while answering (reference ${ctx.requestId}).`;
}

/**
 * Explain to the user why the model stopped without writing an answer, so a
 * successful-but-empty turn shows a helpful note instead of a blank message.
 */
function noAnswerMessage(finishReason: string | undefined): string {
  switch (finishReason) {
    case "length":
      return "I ran out of output space before I could finish answering. This can happen when a reasoning model spends its whole token budget thinking. Please try again, or switch to a different model in Settings.";
    case "content-filter":
      return "The response was blocked by the model's content filter before an answer could be produced. Try rephrasing your question.";
    default:
      return "I finished without producing an answer. This can happen intermittently with some models — try sending the message again, or switch models in Settings.";
  }
}

/** Id of the assistant message a turn streams into; stable across attempts. */
function turnMessageId(requestId: string): string {
  return `msg-${requestId}`;
}

/**
 * Run the deterministic research + synthesis pipeline inside a single typed
 * `UIMessageStream`. Emits `{ type: "start" }` immediately so live research
 * progress cards reach the run buffer before final answer synthesis begins,
 * and appends a fallback note if the model finishes empty.
 *
 * `run` may throw `TurnDeferredError` to leave the turn for a later attempt.
 */
export function createPipelineStream(
  run: (writer: UIMessageStreamWriter<ChatUIMessage>) => Promise<StreamResult>,
  ctx: {
    requestId: string;
    modelInfo: string | (() => string);
    signal?: AbortSignal;
    /** Live lookup for this turn's retrieved sources (citation allowlist). */
    getAllowedSources?: () => ResearchSource[];
    /**
     * Whether to open the message with a `start` chunk. An attempt that
     * continues an earlier attempt's stream must not.
     */
    emitStart: boolean;
    /**
     * Always runs once the turn's work is over, however it ended; given the
     * deferral if the turn was left for a later attempt.
     */
    onSettled?: (deferral: TurnDeferredError | undefined) => void | Promise<void>;
    /** Called when the first of the answer's text is written to the stream. */
    onAnswerText?: () => void;
    /** Called when the turn ends in an error that is shown to the user. */
    onFailed?: () => void;
  },
): PipelineStream {
  const currentModelInfo = () =>
    typeof ctx.modelInfo === "function" ? ctx.modelInfo() : ctx.modelInfo;

  let deferral: TurnDeferredError | undefined;
  let settle!: (value: TurnDeferredError | undefined) => void;
  const settled = new Promise<TurnDeferredError | undefined>((resolve) => {
    settle = resolve;
  });

  const execute = async (
    writer: UIMessageStreamWriter<ChatUIMessage>,
  ): Promise<void> => {
    if (ctx.emitStart) {
      // The id is the same every time this turn's stream is replayed, so a
      // client that reconnects rebuilds the message it already shows instead
      // of a new one.
      writer.write({ type: "start", messageId: turnMessageId(ctx.requestId) });
    }

    let result: StreamResult;
    try {
      result = await run(writer);
    } catch (error) {
      if (isTurnDeferred(error)) {
        logInfo("turn-deferred", {
          requestId: ctx.requestId,
          reason: error.reason,
          delayMs: error.delayMs,
        });
        deferral = error;
        return;
      }
      if (isAbortError(error) || ctx.signal?.aborted) {
        logInfo("abort", { requestId: ctx.requestId, model: currentModelInfo() });
        writer.write({ type: "abort" });
        return;
      }
      throw error;
    }

    const reader = result
      .toUIMessageStream<ChatUIMessage>({
        sendStart: false,
        sendFinish: false,
        // A failure part-way through the answer. `streamText` has logged it.
        onError: (error) =>
          clientErrorMessage(error, {
            requestId: ctx.requestId,
            modelInfo: currentModelInfo(),
          }),
      })
      .getReader();

    let sawText = false;
    let wroteText = false;
    let sawTerminal = false;
    let strippedCitations = 0;
    // Per-text-part buffer plus fenced-code state. Citation verification is
    // line-buffered (so markdown links are never split across flushes), but
    // a fence opened in one flush and closed in a later one must still be
    // treated as code throughout, and very long lines must not stall the
    // stream until text-end.
    const FLUSH_CHAR_CAP = 4_096;
    const REASONING_FLUSH_CHARS = 120;
    type TextState = { buffer: string; inFence: boolean };
    type ReasoningState = {
      buffer: string;
      providerMetadata?: Record<string, Record<string, unknown>>;
    };
    const textBuffers = new Map<string, TextState>();
    const reasoningBuffers = new Map<string, ReasoningState>();

    const flushReasoning = (id: string, force: boolean) => {
      const state = reasoningBuffers.get(id);
      if (!state || !state.buffer) return;
      if (
        !force &&
        !state.buffer.includes("\n") &&
        state.buffer.length < REASONING_FLUSH_CHARS
      ) {
        return;
      }
      const delta = state.buffer;
      const providerMetadata = state.providerMetadata;
      state.buffer = "";
      state.providerMetadata = undefined;
      if (force) reasoningBuffers.delete(id);
      writer.write({
        type: "reasoning-delta",
        id,
        delta,
        ...(providerMetadata != null ? { providerMetadata } : {}),
      } as Parameters<typeof writer.write>[0]);
    };

    const verifyFragment = (state: TextState, emit: string): string => {
      if (state.inFence) {
        const closeIdx = emit.indexOf("```");
        if (closeIdx === -1) return emit; // still inside the fence
        state.inFence = false;
        const head = emit.slice(0, closeIdx + 3);
        return head + verifyFragment(state, emit.slice(closeIdx + 3));
      }
      const fenceCount = (emit.match(/```/g) ?? []).length;
      if (fenceCount % 2 === 1) state.inFence = true;
      const verified = verifyCitations(emit, ctx.getAllowedSources?.() ?? []);
      strippedCitations += verified.strippedCount;
      return verified.text;
    };

    const flushText = (id: string, force: boolean) => {
      const state = textBuffers.get(id);
      if (!state || !state.buffer) return;
      const buffer = state.buffer;
      let emit = buffer;
      if (!force) {
        // Prefer a newline boundary; for very long single lines, fall back
        // to the last space once past the cap (spaces never occur inside a
        // bare URL, so this cannot split a citation URL).
        let boundary = buffer.lastIndexOf("\n");
        if (boundary === -1 && buffer.length >= FLUSH_CHAR_CAP) {
          boundary = buffer.lastIndexOf(" ");
        }
        if (boundary === -1) return;
        emit = buffer.slice(0, boundary + 1);
        state.buffer = buffer.slice(boundary + 1);
      } else {
        state.buffer = "";
        textBuffers.delete(id);
      }
      const text = verifyFragment(state, emit);
      if (text) {
        if (!wroteText) {
          wroteText = true;
          ctx.onAnswerText?.();
        }
        writer.write({ type: "text-delta", id, delta: text });
      }
    };

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value.type === "reasoning-delta") {
          const r = value as {
            id: string;
            delta: string;
            providerMetadata?: Record<string, Record<string, unknown>>;
          };
          const state = reasoningBuffers.get(r.id) ?? { buffer: "" };
          state.buffer += r.delta;
          if (r.providerMetadata != null) {
            state.providerMetadata = r.providerMetadata;
          }
          reasoningBuffers.set(r.id, state);
          flushReasoning(r.id, false);
          continue;
        }
        if (reasoningBuffers.size > 0) {
          for (const id of [...reasoningBuffers.keys()]) {
            flushReasoning(id, true);
          }
        }
        if (value.type === "text-delta") {
          sawText = true;
          const id = (value as { id: string }).id;
          const state = textBuffers.get(id) ?? { buffer: "", inFence: false };
          state.buffer += value.delta;
          textBuffers.set(id, state);
          flushText(id, false);
          continue;
        }
        if (value.type === "text-end") {
          flushText((value as { id: string }).id, true);
        }
        if (value.type === "abort" || value.type === "error") {
          sawTerminal = true;
          if (value.type === "error") ctx.onFailed?.();
        }
        writer.write(value);
      }
      for (const id of [...reasoningBuffers.keys()]) flushReasoning(id, true);
      for (const id of [...textBuffers.keys()]) flushText(id, true);
      if (strippedCitations > 0) {
        logInfo("citation-verification", {
          requestId: ctx.requestId,
          stripped: strippedCitations,
        });
      }
    } catch (error) {
      if (isAbortError(error) || ctx.signal?.aborted) {
        writer.write({ type: "abort" });
        return;
      }
      throw error;
    }

    if (sawTerminal || ctx.signal?.aborted) {
      if (!sawTerminal && ctx.signal?.aborted) {
        writer.write({ type: "abort" });
      }
      return;
    }

    const finishReason: FinishReason | undefined = await Promise.resolve(
      result.finishReason,
    ).catch(() => undefined);

    if (!sawText) {
      logInfo("empty-answer", {
        requestId: ctx.requestId,
        modelInfo: currentModelInfo(),
        finishReason,
      });
      const id = crypto.randomUUID();
      writer.write({ type: "text-start", id });
      writer.write({
        type: "text-delta",
        id,
        delta: noAnswerMessage(finishReason),
      });
      writer.write({ type: "text-end", id });
    }

    writer.write({
      type: "finish",
      finishReason: finishReason ?? "stop",
    });
  };

  const stream = createUIMessageStream<ChatUIMessage>({
    execute: async ({ writer }) => {
      try {
        await execute(writer);
      } finally {
        try {
          await ctx.onSettled?.(deferral);
        } catch (error) {
          logError("stream-settle", error, { requestId: ctx.requestId });
        }
        // The SDK closes the stream only after this function returns, so
        // whoever reads the stream to its end finds this already settled.
        settle(deferral);
      }
    },
    onError: (error) => {
      const info = currentModelInfo();
      ctx.onFailed?.();
      logError("stream", error, {
        requestId: ctx.requestId,
        modelInfo: info,
      });
      return clientErrorMessage(error, {
        requestId: ctx.requestId,
        modelInfo: info,
      });
    },
  });

  return { stream, deferral: settled };
}
