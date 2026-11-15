/**
 * Every turn's stream closes with the AI SDK's `[DONE]` frame once the turn
 * is over. A stream that ends without it has stopped short of the turn: the
 * server handed the turn over to a later request (see lib/agent/detached.ts),
 * or the connection was cut in a way the browser reports as a normal end.
 *
 * Left alone, the chat would take such a stream for a complete answer. This
 * makes it end in the error a dropped connection gives instead, which the
 * page already answers by reconnecting to the turn.
 */
const DONE_FRAME = "data: [DONE]";
/** Enough of the stream's end to hold the closing frame and its newlines. */
const ENDING_CHARS = 64;

/** Worded so that the AI SDK and the page both classify it as a disconnect. */
const UNFINISHED_MESSAGE =
  "network error: the response stream ended before the turn finished";

export function failIfUnfinished(
  response: Response,
  onUnfinished?: () => void,
): Response {
  const isEventStream = response.headers
    .get("content-type")
    ?.includes("text/event-stream");
  if (!response.ok || !response.body || !isEventStream) return response;

  const decoder = new TextDecoder();
  let ending = "";
  const checked = response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        ending = (ending + decoder.decode(chunk, { stream: true })).slice(-ENDING_CHARS);
        controller.enqueue(chunk);
      },
      // Only runs when the source ends normally: an aborted or failed fetch
      // surfaces as its own error.
      flush(controller) {
        if (ending.trimEnd().endsWith(DONE_FRAME)) return;
        onUnfinished?.();
        controller.error(new TypeError(UNFINISHED_MESSAGE));
      },
    }),
  );
  return new Response(checked, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}
