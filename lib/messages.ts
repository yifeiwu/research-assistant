import type { ModelMessage } from "ai";
import type { ChatMessage } from "./types/chat";

/** True when a thread's latest turn has no completed assistant answer. */
export function endsUnanswered(messages: ChatMessage[]): boolean {
  const last = messages[messages.length - 1];
  if (!last) return false;
  if (last.role === "user") return true;
  return last.role === "assistant" && last.text.trim().length === 0;
}

/** Id of the most recent user message (identifies the current turn for Stop). */
export function findLastUserMessageId(messages: ChatMessage[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user" && messages[i].id) {
      return messages[i].id;
    }
  }
  return undefined;
}

/** Text of the most recent user message. */
export function latestUserText(messages: ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      return messages[i].text.trim();
    }
  }
  return "";
}

/**
 * Strip empty assistant messages and research/reasoning metadata from prior
 * turns before sending conversation history to the model.
 */
export function toModelMessages(messages: ChatMessage[]): ModelMessage[] {
  const result: ModelMessage[] = [];
  for (const message of messages) {
    if (message.role === "assistant" && !message.text.trim()) continue;
    result.push({ role: message.role, content: message.text });
  }
  return result;
}
