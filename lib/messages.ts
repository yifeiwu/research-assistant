import type { ModelMessage } from "ai";
import { estimateTokens } from "./tokens";
import { normalizeUrlKey } from "./sources";
import type { ChatMessage, ResearchSource } from "./types/chat";

const DEFAULT_HISTORY_TOKEN_BUDGET = 1_400;
const MAX_TOTAL_PROMPT_MESSAGE_TOKENS = 2_800;
const MAX_LATEST_USER_CHARS = 10_000;
const PER_ASSISTANT_CHAR_CAP = 2_400;

/** True when a thread's latest turn has no completed assistant answer. */
export function endsUnanswered(messages: ChatMessage[]): boolean {
  const last = messages[messages.length - 1];
  if (!last) return false;
  if (last.role === "user") return true;
  return last.role === "assistant" && last.text.trim().length === 0;
}

/** Id of the most recent user message (identifies the current turn). */
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
 * Collect deduplicated `ResearchSource[]` from all prior assistant messages in
 * the conversation so follow-up answers can validly cite earlier turns' sources.
 */
export function collectPriorSources(messages: ChatMessage[]): ResearchSource[] {
  const byKey = new Map<string, ResearchSource>();
  for (const msg of messages) {
    if (msg.role !== "assistant" || !msg.sources) continue;
    for (const src of msg.sources) {
      const key = normalizeUrlKey(src.url);
      if (!key) continue;
      const existing = byKey.get(key);
      if (!existing) {
        byKey.set(key, src);
      } else if (!existing.title && src.title) {
        byKey.set(key, { ...existing, title: src.title });
      }
    }
  }
  return [...byKey.values()];
}

function compactPriorAssistantText(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= PER_ASSISTANT_CHAR_CAP) return trimmed;
  const slice = trimmed.slice(0, PER_ASSISTANT_CHAR_CAP);
  const boundary = Math.max(slice.lastIndexOf("\n\n"), slice.lastIndexOf(". "));
  const head = boundary >= 1_200 ? slice.slice(0, boundary + 1) : slice;
  return `${head.trimEnd()}\n\n[...earlier details omitted...]`;
}

function compactLatestUserText(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= MAX_LATEST_USER_CHARS) return trimmed;
  const headChars = Math.floor(MAX_LATEST_USER_CHARS * 0.75);
  const tailChars = MAX_LATEST_USER_CHARS - headChars;
  return `${trimmed.slice(0, headChars).trimEnd()}\n\n[...middle of message omitted to fit model context limit...]\n\n${trimmed.slice(-tailChars).trimStart()}`;
}

/**
 * Convert `ChatMessage[]` into bounded `ModelMessage[]` for synthesis:
 * - Keeps the latest user message (compacting only extreme pastes >10K chars).
 * - Compacts oversized prior assistant turns and walks backwards within
 *   `historyTokenBudget` so multi-turn follow-ups never blow Groq's 8K TPM cap.
 */
export function toModelMessages(
  messages: ChatMessage[],
  historyTokenBudget: number = DEFAULT_HISTORY_TOKEN_BUDGET,
): ModelMessage[] {
  const nonEmpty = messages.filter(
    (m) => m.role === "user" || m.text.trim().length > 0,
  );
  if (nonEmpty.length === 0) return [];

  const lastIdx = nonEmpty.length - 1;
  const latest = nonEmpty[lastIdx];
  const latestContent =
    latest.role === "user"
      ? compactLatestUserText(latest.text)
      : latest.text.trim();
  const latestTokens = estimateTokens(latestContent);
  const effectiveHistoryBudget = Math.min(
    historyTokenBudget,
    Math.max(0, MAX_TOTAL_PROMPT_MESSAGE_TOKENS - latestTokens),
  );
  const prior = nonEmpty.slice(0, lastIdx);

  if (prior.length === 0 || effectiveHistoryBudget <= 0) {
    return [{ role: latest.role, content: latestContent }];
  }

  let usedTokens = 0;
  const keptPrior: ModelMessage[] = [];

  for (let i = prior.length - 1; i >= 0; i--) {
    const msg = prior[i];
    const content =
      msg.role === "assistant"
        ? compactPriorAssistantText(msg.text)
        : msg.text.trim();
    const tokens = estimateTokens(content);
    if (keptPrior.length > 0 && usedTokens + tokens > effectiveHistoryBudget) {
      break;
    }
    if (keptPrior.length === 0 && tokens > effectiveHistoryBudget) {
      const maxChars = Math.max(400, effectiveHistoryBudget * 4);
      keptPrior.push({ role: msg.role, content: content.slice(0, maxChars) });
      break;
    }
    usedTokens += tokens;
    keptPrior.push({ role: msg.role, content });
  }

  keptPrior.reverse();
  // Drop any leading orphaned assistant message so history starts cleanly with `user`.
  while (keptPrior.length > 0 && keptPrior[0].role !== "user") {
    keptPrior.shift();
  }

  return [...keptPrior, { role: latest.role, content: latestContent }];
}
