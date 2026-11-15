import type { UIMessage } from "ai";

/**
 * Reconnecting to a turn replays its stream from the start, so the assistant
 * message on screen has to be taken out of the chat and built again. Shown
 * as it happens, the answer would blank and refill. Instead the message that
 * was taken out is *held* and shown until the replay has caught up with it.
 */

/** Characters of answer and reasoning text in a message. */
function textLength(message: UIMessage): number {
  let total = 0;
  for (const part of message.parts) {
    if (part.type === "text" || part.type === "reasoning") total += part.text.length;
  }
  return total;
}

/**
 * Whether a message being replayed shows at least as much as `held` did. A
 * replay adds parts in the order they were first streamed, so it is enough
 * to compare how many there are and how much text they hold.
 */
export function hasCaughtUp(replayed: UIMessage | undefined, held: UIMessage): boolean {
  if (!replayed || replayed.role !== "assistant") return false;
  return (
    replayed.parts.length >= held.parts.length &&
    textLength(replayed) >= textLength(held)
  );
}

/** The messages to show while `held` stands in for a message being replayed. */
export function withHeldMessage(
  live: UIMessage[],
  held: UIMessage | null,
): UIMessage[] {
  if (!held) return live;
  const last = live[live.length - 1];
  if (last?.role !== "assistant") return [...live, held];
  return hasCaughtUp(last, held) ? live : [...live.slice(0, -1), held];
}
