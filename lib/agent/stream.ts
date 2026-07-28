import "server-only";
import {
  createUIMessageStream,
  createUIMessageStreamResponse,
  streamText,
} from "ai";
import { logInfo, logError, extractFailedGeneration } from "@/lib/logger";

/** The parts of a `streamText` result this module consumes. */
type StreamResult = Pick<
  ReturnType<typeof streamText>,
  "toUIMessageStream" | "finishReason"
>;

/** Turn an error into a user-facing message, including Groq's failed_generation. */
export function clientErrorMessage(error: unknown): string {
  let message = "Unknown error";
  if (typeof error === "string") message = error;
  else if (error instanceof Error) message = error.message;
  else if (error != null) message = JSON.stringify(error);

  const failed = extractFailedGeneration(error);
  if (failed) {
    const snippet = failed.length > 600 ? `${failed.slice(0, 600)}…` : failed;
    message += `\n\nModel output that failed to parse:\n${snippet}`;
  }
  return message;
}

/**
 * Explain to the user why the model stopped without writing an answer, so a
 * successful-but-empty turn shows a helpful note instead of a blank message.
 */
export function noAnswerMessage(finishReason: string | undefined): string {
  switch (finishReason) {
    case "length":
      return "I ran out of output space before I could finish answering. This can happen when a reasoning model spends its whole token budget thinking. Please try again, or switch to a different model in Settings.";
    case "content-filter":
      return "The response was blocked by the model's content filter before an answer could be produced. Try rephrasing your question.";
    case "tool-calls":
      return "I used up my research budget without writing an answer. Please try sending your question again.";
    default:
      return "I finished without producing an answer. This can happen intermittently with some models — try sending the message again, or switch models in Settings.";
  }
}

/**
 * Forward the model's stream, but if it completes without any answer text
 * (e.g. finishReason "length"/"content-filter"/"tool-calls", or a reasoning
 * model that never wrote a final answer), append a note explaining why so the
 * user never sees a silently blank turn.
 */
export function streamWithEmptyAnswerFallback(
  result: StreamResult,
  ctx: { requestId: string; modelInfo: string },
): Response {
  const stream = createUIMessageStream({
    execute: async ({ writer }) => {
      const reader = result.toUIMessageStream().getReader();
      let sawText = false;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value.type === "text-delta") sawText = true;
        writer.write(value);
      }

      if (!sawText) {
        const finishReason = await Promise.resolve(result.finishReason).catch(
          () => undefined,
        );
        logInfo("empty-answer", { ...ctx, finishReason });
        const id = crypto.randomUUID();
        writer.write({ type: "text-start", id });
        writer.write({
          type: "text-delta",
          id,
          delta: noAnswerMessage(finishReason),
        });
        writer.write({ type: "text-end", id });
      }
    },
    onError: (error) => {
      logError("stream", error, ctx);
      return clientErrorMessage(error);
    },
  });

  return createUIMessageStreamResponse({ stream });
}
