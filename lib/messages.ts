import type { UIMessage } from "ai";

type TextPart = { type: "text"; text: string };

function isTextPart(part: UIMessage["parts"][number]): part is TextPart {
  return part.type === "text";
}

/**
 * Join the text parts of a message into a single string. The separator defaults
 * to a blank line (how answers/prompts are rendered); pass a different separator
 * where a more compact form is wanted (e.g. " " for titles).
 */
export function getMessageText(message: UIMessage, separator = "\n\n"): string {
  return message.parts
    .filter(isTextPart)
    .map((p) => p.text)
    .join(separator);
}

/** Text of the most recent user message (used to focus tool summaries). */
export function latestUserText(messages: UIMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role !== "user") continue;
    return getMessageText(messages[i], "\n").trim();
  }
  return "";
}

/**
 * Strip tool invocations and reasoning from PRIOR assistant turns so we don't
 * resend large search/crawl payloads on every follow-up (keeps token usage and
 * latency down). The final answer text of each turn is kept for context, and
 * assistant turns that produced no text are dropped entirely.
 */
export function pruneToolHistory(messages: UIMessage[]): UIMessage[] {
  const result: UIMessage[] = [];
  for (const message of messages) {
    if (message.role !== "assistant") {
      result.push(message);
      continue;
    }
    const textParts = message.parts.filter((p) => p.type === "text");
    const hasText = textParts.some(
      (p) => p.type === "text" && p.text.trim().length > 0,
    );
    if (!hasText) continue;
    result.push({ ...message, parts: textParts });
  }
  return result;
}
