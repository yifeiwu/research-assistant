import type {
  ChatMessage,
  ResearchSource,
  ResearchStepData,
  ResearchStepPhase,
} from "./types/chat";

/** A single saved chat thread persisted in the browser. */
export type Conversation = {
  id: string;
  title: string;
  messages: ChatMessage[];
  /** True while a durable server turn is still running or uncollected in Redis. */
  pending?: boolean;
  /** Unique `runId` of the currently pending turn. */
  pendingRunId?: string;
  /** Epoch ms when the pending turn started; feeds the elapsed timer across reloads. */
  pendingSince?: number;
  unansweredReason?: "stopped" | "expired";
  createdAt: number;
  updatedAt: number;
};

const CONVERSATIONS_STORAGE_KEY = "web-seek-conversations";
const ACTIVE_CONVERSATION_STORAGE_KEY = "web-seek-active-conversation";
const MAX_TITLE_LENGTH = 60;
const MAX_CONVERSATIONS = 20;

export function createConversationId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `c_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  }
}

/** Derive a short human-readable title from the first user message. */
export function deriveTitle(messages: ChatMessage[]): string {
  const firstUser = messages.find((m) => m.role === "user");
  const trimmed = (firstUser?.text ?? "").replace(/\s+/g, " ").trim();
  if (!trimmed) return "New chat";
  return trimmed.length > MAX_TITLE_LENGTH
    ? `${trimmed.slice(0, MAX_TITLE_LENGTH).trimEnd()}…`
    : trimmed;
}

/**
 * Strip bulky condensed research `notes` from step snapshots before writing to
 * `localStorage` so saved threads stay compact (<3 KB each) without ever
 * triggering `QuotaExceededError`.
 */
export function stripConversationNotes(conv: Conversation): Conversation {
  let changed = false;
  const messages = conv.messages.map((msg) => {
    if (!msg.steps?.some((s) => s.notes != null)) return msg;
    changed = true;
    return {
      ...msg,
      steps: msg.steps.map(({ notes: _omit, ...rest }) => rest),
    };
  });
  return changed ? { ...conv, messages } : conv;
}

export function loadConversations(): Conversation[] {
  try {
    const raw = window.localStorage.getItem(CONVERSATIONS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(isConversation)
      .map(sanitizeLoadedConversation)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, MAX_CONVERSATIONS);
  } catch {
    return [];
  }
}

export function saveConversations(conversations: Conversation[]): Conversation[] {
  const capped = [...conversations]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, MAX_CONVERSATIONS);
  try {
    const compact = capped.map(stripConversationNotes);
    window.localStorage.setItem(
      CONVERSATIONS_STORAGE_KEY,
      JSON.stringify(compact),
    );
  } catch {
    // Ignore storage unavailability (e.g. private browsing restrictions).
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

const VALID_STEP_PHASES = new Set<ResearchStepPhase>([
  "planning",
  "searching",
  "reading",
  "checking-gaps",
  "done",
  "error",
]);

function sanitizeLoadedSources(raw: unknown): ResearchSource[] {
  if (!Array.isArray(raw)) return [];
  const out: ResearchSource[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    if (typeof rec.url !== "string" || !/^https?:\/\//i.test(rec.url.trim())) {
      continue;
    }
    out.push({
      url: rec.url.trim(),
      ...(typeof rec.title === "string" && rec.title.trim()
        ? { title: rec.title.trim() }
        : {}),
      ...(typeof rec.publishedDate === "string" && rec.publishedDate.trim()
        ? { publishedDate: rec.publishedDate.trim() }
        : {}),
    });
  }
  return out;
}

function sanitizeLoadedSteps(raw: unknown): ResearchStepData[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: ResearchStepData[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const round = typeof rec.round === "number" && Number.isFinite(rec.round) ? rec.round : out.length + 1;
    const phase: ResearchStepPhase =
      typeof rec.phase === "string" && VALID_STEP_PHASES.has(rec.phase as ResearchStepPhase)
        ? (rec.phase as ResearchStepPhase)
        : "done";
    out.push({
      round,
      phase,
      ...(typeof rec.query === "string" ? { query: rec.query } : {}),
      sources: sanitizeLoadedSources(rec.sources),
      ...(typeof rec.error === "string" ? { error: rec.error } : {}),
      ...(Array.isArray(rec.degraded)
        ? { degraded: rec.degraded.filter((d): d is string => typeof d === "string") }
        : {}),
    });
  }
  return out.length > 0 ? out : undefined;
}

function sanitizeLoadedConversation(conv: Conversation): Conversation {
  return {
    ...conv,
    messages: conv.messages.map((m) => {
      const sources = m.sources ? sanitizeLoadedSources(m.sources) : undefined;
      const steps = sanitizeLoadedSteps(m.steps);
      return {
        id: m.id,
        role: m.role,
        text: m.text,
        ...(typeof m.reasoning === "string" ? { reasoning: m.reasoning } : {}),
        ...(steps ? { steps } : {}),
        ...(sources && sources.length > 0 ? { sources } : {}),
      };
    }),
  };
}

function isChatMessage(value: unknown): value is ChatMessage {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "string" &&
    (v.role === "user" || v.role === "assistant") &&
    typeof v.text === "string"
  );
}

function isConversation(value: unknown): value is Conversation {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "string" &&
    typeof v.title === "string" &&
    Array.isArray(v.messages) &&
    v.messages.every(isChatMessage) &&
    (v.pending === undefined || typeof v.pending === "boolean") &&
    (v.pendingRunId === undefined || typeof v.pendingRunId === "string") &&
    (v.pendingSince === undefined || typeof v.pendingSince === "number") &&
    typeof v.createdAt === "number" &&
    typeof v.updatedAt === "number"
  );
}
