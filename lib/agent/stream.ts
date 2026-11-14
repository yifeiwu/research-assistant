import "server-only";
import {
  APICallError,
  RetryError,
  createUIMessageStream,
  createUIMessageStreamResponse,
  streamText,
  type FinishReason,
  type UIMessageStreamWriter,
} from "ai";
import { logInfo, logError, extractFailedGeneration } from "@/lib/logger";
import { groqModelLabel } from "@/lib/models";
import { verifyCitations } from "@/lib/citations";
import type { ChatUIMessage, ResearchSource } from "@/lib/types/chat";

/** The parts of a `streamText` result this module consumes. */
export type StreamResult = Pick<
  ReturnType<typeof streamText>,
  "toUIMessageStream" | "finishReason"
>;

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

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

  const retryIn = rawMessage.match(/try again in ([^.]+?)\./i)?.[1]?.trim();
  const waitHint = retryIn
    ? ` You can try again in about ${retryIn}, or`
    : " You can wait a bit, or";

  return (
    `You've hit the rate limit for ${label}.` +
    `${waitHint} switch to a different model in Settings and send your message again.`
  );
}

/** Turn an error into a user-facing message, including Groq's failed_generation. */
function clientErrorMessage(error: unknown, modelInfo?: string): string {
  const rateLimited = rateLimitMessage(error, modelInfo);
  if (rateLimited) return rateLimited;

  let message = "Unknown error";
  if (typeof error === "string") message = error;
  else if (error instanceof Error) message = error.message;
  else if (error != null) message = JSON.stringify(error);

  const failed = extractFailedGeneration(error);
  if (failed) {
    const snippet = failed.length > 600 ? `${failed.slice(0, 600)}…` : failed;
    message += `\n\nModel output:\n${snippet}`;
  }
  return message;
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

/**
 * Run the deterministic research + synthesis pipeline inside a single typed
 * `UIMessageStream`. Emits `{ type: "start" }` immediately so live research
 * progress cards stream to the client (and Upstash Redis) before final answer
 * synthesis begins, and appends a fallback note if the model finishes empty.
 */
export function createPipelineStreamResponse(
  run: (writer: UIMessageStreamWriter<ChatUIMessage>) => Promise<StreamResult>,
  ctx: {
    requestId: string;
    modelInfo: string;
    signal?: AbortSignal;
    /** Live lookup for this turn's retrieved sources (citation allowlist). */
    getAllowedSources?: () => ResearchSource[];
  },
  options?: {
    consumeSseStream?: (options: {
      stream: ReadableStream<string>;
    }) => void | PromiseLike<void>;
  },
): Response {
  const stream = createUIMessageStream<ChatUIMessage>({
    execute: async ({ writer }) => {
      writer.write({ type: "start" });

      let result: StreamResult;
      try {
        result = await run(writer);
      } catch (error) {
        if (isAbortError(error) || ctx.signal?.aborted) {
          logInfo("abort", { requestId: ctx.requestId, model: ctx.modelInfo });
          writer.write({ type: "abort" });
          return;
        }
        throw error;
      }

      const reader = result
        .toUIMessageStream<ChatUIMessage>({
          sendStart: false,
          sendFinish: false,
        })
        .getReader();

      let sawText = false;
      let sawTerminal = false;
      let strippedCitations = 0;
      // Per-text-part buffer plus fenced-code state. Citation verification is
      // line-buffered (so markdown links are never split across flushes), but
      // a fence opened in one flush and closed in a later one must still be
      // treated as code throughout, and very long lines must not stall the
      // stream until text-end.
      const FLUSH_CHAR_CAP = 4_096;
      type TextState = { buffer: string; inFence: boolean };
      const textBuffers = new Map<string, TextState>();

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
          writer.write({ type: "text-delta", id, delta: text });
        }
      };

      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
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
          }
          writer.write(value);
        }
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
          modelInfo: ctx.modelInfo,
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
    },
    onError: (error) => {
      logError("stream", error, {
        requestId: ctx.requestId,
        modelInfo: ctx.modelInfo,
      });
      return clientErrorMessage(error, ctx.modelInfo);
    },
  });

  return createUIMessageStreamResponse({
    stream,
    consumeSseStream: options?.consumeSseStream,
  });
}
