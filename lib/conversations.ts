import type { UIMessage } from "ai";
import { getMessageText } from "./messages";
import { isPending, type ThreadTurn } from "./turn-machine";

/** A single saved chat thread, persisted in the browser. */
export type Conversation = {
  id: string;
  title: string;
  messages: UIMessage[];
  /** True while an assistant response is still generating (or uncollected) in Redis. */
  pending?: boolean;
  /** When the pending turn was sent (epoch ms); the elapsed clock counts from here. */
  pendingSince?: number;
  createdAt: number;
  updatedAt: number;
};

const CONVERSATIONS_STORAGE_KEY = "web-seek-conversations";
const ACTIVE_CONVERSATION_STORAGE_KEY = "web-seek-active-conversation";
/** Old single-thread key, migrated into a conversation on first load. */
const LEGACY_MESSAGES_STORAGE_KEY = "web-seek-messages";

const MAX_TITLE_LENGTH = 60;

/**
 * Throttle interval (ms) for streaming message notifications (~20 fps).
 * Paired with `useChatState` (`DefaultLane`) so UI re-renders stay smooth
 * during fast token bursts without fighting timer/polling state updates.
 */
export const CHAT_STREAM_THROTTLE_MS = 50;

/**
 * Cap on saved threads. Once exceeded, the least-recently-updated conversations
 * are evicted (LRU) so localStorage doesn't grow without bound.
 */
const MAX_CONVERSATIONS = 20;

/** Keep only the `MAX_CONVERSATIONS` most recently updated threads. */
function capConversations(conversations: Conversation[]): Conversation[] {
  return [...conversations]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, MAX_CONVERSATIONS);
}

/**
 * Strip bulky research notes / legacy tool outputs from a conversation's
 * messages while keeping answer text, queries, and structured source pills
 * intact. Used only when `localStorage` hits its browser size quota.
 */
function compactConversation(conv: Conversation): Conversation {
  let changed = false;
  const messages = conv.messages.map((msg) => {
    if (msg.role !== "assistant") return msg;
    let msgChanged = false;
    const parts = msg.parts.map((part) => {
      if (
        part.type === "data-research-step" &&
        "data" in part &&
        part.data &&
        typeof part.data === "object" &&
        "notes" in part.data &&
        part.data.notes
      ) {
        msgChanged = true;
        const { notes: _omit, ...restData } = part.data as Record<
          string,
          unknown
        >;
        return { ...part, data: restData } as typeof part;
      }
      if (
        part.type === "dynamic-tool" &&
        "output" in part &&
        part.output != null
      ) {
        msgChanged = true;
        return { ...part, output: undefined } as typeof part;
      }
      return part;
    });
    if (!msgChanged) return msg;
    changed = true;
    return { ...msg, parts };
  });
  return changed ? { ...conv, messages } : conv;
}

function trySetStorage(key: string, value: Conversation[]): boolean {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export function createConversationId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `c_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  }
}

/** Derive a short human-readable title from the first user message. */
export function deriveTitle(messages: UIMessage[]): string {
  const firstUser = messages.find((m) => m.role === "user");
  const text = firstUser ? getMessageText(firstUser, " ") : "";
  const trimmed = text.replace(/\s+/g, " ").trim();
  if (!trimmed) return "New chat";
  return trimmed.length > MAX_TITLE_LENGTH
    ? `${trimmed.slice(0, MAX_TITLE_LENGTH).trimEnd()}…`
    : trimmed;
}

/**
 * The saved conversations with a turn's prompt written into its thread, as
 * soon as the turn is under way: a reload, or a switch to another thread,
 * finds the question there and (through `pending`) knows to go and look for
 * the answer. Returns null when there is nothing to write.
 *
 * `turn` has to be the thread's turn as it stands now, not as it stood in
 * whichever render asked for this. By the time this runs the turn may be
 * over (a request refused at once), or the thread deleted.
 */
export function withTurnPrompt(
  conversations: Conversation[],
  id: string,
  promptMessages: UIMessage[],
  turn: ThreadTurn | undefined,
  now: number,
): Conversation[] | null {
  // No turn at all: the thread was deleted in the meantime.
  if (!turn || promptMessages.length === 0) return null;
  const existing = conversations.find((c) => c.id === id);
  const lastPromptId = promptMessages[promptMessages.length - 1].id;
  const pending = isPending(turn.phase);
  if (pending) {
    // Already saved as pending with this prompt.
    if (
      existing?.pending &&
      existing.messages.length === promptMessages.length &&
      existing.messages[existing.messages.length - 1]?.id === lastPromptId
    ) {
      return null;
    }
  } else if (existing?.messages.some((m) => m.id === lastPromptId)) {
    // The turn is over and what it left has been saved, prompt included.
    return null;
  }

  const updated: Conversation = {
    ...(existing ?? { id, createdAt: now }),
    title: existing?.title ?? deriveTitle(promptMessages),
    messages: promptMessages,
    pending,
    pendingSince: pending ? (turn.since ?? now) : undefined,
    updatedAt: now,
  };
  return [updated, ...conversations.filter((c) => c.id !== id)];
}

export function loadConversations(): Conversation[] {
  try {
    const raw = window.localStorage.getItem(CONVERSATIONS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const sorted = parsed
      .filter(isConversation)
      .sort((a, b) => b.updatedAt - a.updatedAt);
    return sorted.slice(0, MAX_CONVERSATIONS);
  } catch {
    return [];
  }
}

/**
 * Persist the thread list, evicting all but the most recently updated
 * `MAX_CONVERSATIONS`. If `localStorage` hits `QuotaExceededError`, older
 * research notes are compacted first, followed by progressive LRU eviction so
 * new turns and `pending: false` settlements never silently fail to save.
 */
export function saveConversations(
  conversations: Conversation[],
): Conversation[] {
  const capped = capConversations(conversations);
  if (trySetStorage(CONVERSATIONS_STORAGE_KEY, capped)) {
    return capped;
  }

  // Pass 1: compact research notes on older threads (keep top 2 untouched).
  let working = capped.map((c, idx) =>
    idx >= 2 ? compactConversation(c) : c,
  );
  if (trySetStorage(CONVERSATIONS_STORAGE_KEY, working)) {
    return working;
  }

  // Pass 2: compact research notes on all non-active threads (keep top 1).
  working = working.map((c, idx) => (idx >= 1 ? compactConversation(c) : c));
  if (trySetStorage(CONVERSATIONS_STORAGE_KEY, working)) {
    return working;
  }

  // Pass 3: progressively evict oldest threads down to 1.
  while (working.length > 1) {
    working = working.slice(0, -1);
    if (trySetStorage(CONVERSATIONS_STORAGE_KEY, working)) {
      return working;
    }
  }

  // Pass 4: last resort — compact the remaining active thread's notes too.
  if (working.length === 1) {
    const minimal = [compactConversation(working[0])];
    if (trySetStorage(CONVERSATIONS_STORAGE_KEY, minimal)) {
      return minimal;
    }
  }

  return capped;
}

export function loadActiveConversationId(): string | null {
  try {
    return window.localStorage.getItem(ACTIVE_CONVERSATION_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function saveActiveConversationId(id: string | null): void {
  try {
    if (id) {
      window.localStorage.setItem(ACTIVE_CONVERSATION_STORAGE_KEY, id);
    } else {
      window.localStorage.removeItem(ACTIVE_CONVERSATION_STORAGE_KEY);
    }
  } catch {
    // ignore
  }
}

/**
 * Migrate the pre-history single-thread storage into a conversation. Returns the
 * created conversation, or null if there was nothing to migrate.
 */
export function migrateLegacyMessages(): Conversation | null {
  try {
    const raw = window.localStorage.getItem(LEGACY_MESSAGES_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    window.localStorage.removeItem(LEGACY_MESSAGES_STORAGE_KEY);
    if (!Array.isArray(parsed) || parsed.length === 0) return null;
    const now = Date.now();
    return {
      id: createConversationId(),
      title: deriveTitle(parsed as UIMessage[]),
      messages: parsed as UIMessage[],
      createdAt: now,
      updatedAt: now,
    };
  } catch {
    return null;
  }
}

function isConversation(value: unknown): value is Conversation {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "string" &&
    typeof v.title === "string" &&
    Array.isArray(v.messages) &&
    (v.pending === undefined || typeof v.pending === "boolean") &&
    (v.pendingSince === undefined || typeof v.pendingSince === "number") &&
    typeof v.createdAt === "number" &&
    typeof v.updatedAt === "number"
  );
}
