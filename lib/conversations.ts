import type { UIMessage } from "ai";
import { getMessageText } from "./messages";

/** A single saved chat thread, persisted in the browser. */
export type Conversation = {
  id: string;
  title: string;
  messages: UIMessage[];
  createdAt: number;
  updatedAt: number;
};

export const CONVERSATIONS_STORAGE_KEY = "web-seek-conversations";
export const ACTIVE_CONVERSATION_STORAGE_KEY = "web-seek-active-conversation";
/** Old single-thread key, migrated into a conversation on first load. */
export const LEGACY_MESSAGES_STORAGE_KEY = "web-seek-messages";

const MAX_TITLE_LENGTH = 60;

/**
 * Cap on saved threads. Once exceeded, the least-recently-updated conversations
 * are evicted (LRU) so localStorage doesn't grow without bound.
 */
export const MAX_CONVERSATIONS = 20;

/** Keep only the `MAX_CONVERSATIONS` most recently updated threads. */
function capConversations(conversations: Conversation[]): Conversation[] {
  if (conversations.length <= MAX_CONVERSATIONS) return conversations;
  return [...conversations]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, MAX_CONVERSATIONS);
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
 * `MAX_CONVERSATIONS`. Returns the (possibly trimmed) list actually stored so
 * callers can keep their in-memory state in sync with what was saved.
 */
export function saveConversations(
  conversations: Conversation[],
): Conversation[] {
  const capped = capConversations(conversations);
  try {
    window.localStorage.setItem(
      CONVERSATIONS_STORAGE_KEY,
      JSON.stringify(capped),
    );
  } catch {
    // storage full or unavailable; ignore
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
    typeof v.createdAt === "number" &&
    typeof v.updatedAt === "number"
  );
}
