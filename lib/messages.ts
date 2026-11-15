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

/**
 * True when a thread's latest turn has no answer: it ends on the user's
 * message, or on an assistant message with no answer text (research progress
 * only, or nothing at all).
 */
export function endsUnanswered(messages: UIMessage[]): boolean {
  const last = messages[messages.length - 1];
  if (!last) return false;
  if (last.role === "user") return true;
  return last.role === "assistant" && getMessageText(last).trim().length === 0;
}

/** Id of the most recent user message (identifies the current turn for Stop). */
export function findLastUserMessageId(messages: UIMessage[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user" && typeof messages[i].id === "string") {
      return messages[i].id;
    }
  }
  return undefined;
}

/** Text of the most recent user message (used to focus research queries & summaries). */
export function latestUserText(messages: UIMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role !== "user") continue;
    return getMessageText(messages[i], "\n").trim();
  }
  return "";
}

/**
 * Strip research steps, source metadata, and reasoning parts from PRIOR
 * assistant turns so we only resend final answer text on follow-ups (keeps
 * token usage low and compatible with every model). Assistant turns that
 * produced no text are dropped entirely.
 */
export function pruneAssistantHistory(messages: UIMessage[]): UIMessage[] {
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
