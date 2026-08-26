import "server-only";
import { UI_MESSAGE_STREAM_HEADERS } from "ai";
import { logInfo } from "@/lib/logger";

/**
 * In-process buffer for a chat's UI-message SSE stream.
 *
 * Lets the agent keep generating after the browser drops the original POST
 * (tab switch, backgrounding) and lets a later GET replay + follow the same
 * bytes. This is process-local: it survives a disconnect on a single Node
 * instance (`next dev` / one server), but not a serverless cold start or a
 * hop to another isolate. Redis replaces this map later.
 */
type Subscriber = ReadableStreamDefaultController<Uint8Array>;

type ChatStream = {
  chunks: Uint8Array[];
  subscribers: Set<Subscriber>;
  done: boolean;
  abort: AbortController;
  retainTimer?: ReturnType<typeof setTimeout>;
};

const streams = new Map<string, ChatStream>();
const encoder = new TextEncoder();

/** Keep a finished stream around so a tab that comes back late can still replay. */
const RETAIN_MS = 10 * 60 * 1000;

export function isChatId(value: string): boolean {
  return /^[\w-]{8,80}$/.test(value);
}

/**
 * Open (or replace) the in-memory stream for `chatId`. Aborting the previous
 * job is intentional: a new send on the same thread supersedes an in-flight
 * one. Returns the AbortSignal `streamText` should use — *not* the HTTP
 * request signal, so a dropped client does not cancel generation.
 */
export function startChatStream(chatId: string): AbortSignal {
  const existing = streams.get(chatId);
  if (existing) {
    if (!existing.abort.signal.aborted) existing.abort.abort();
    clearTimeout(existing.retainTimer);
  }

  const entry: ChatStream = {
    chunks: [],
    subscribers: new Set(),
    done: false,
    abort: new AbortController(),
  };
  streams.set(chatId, entry);
  logInfo("stream-start", { chatId });
  return entry.abort.signal;
}

/** Explicit Stop — the only path that should cancel generation. */
export function stopChatStream(chatId: string): boolean {
  const entry = streams.get(chatId);
  if (!entry) return false;
  if (!entry.abort.signal.aborted) {
    entry.abort.abort();
    logInfo("stream-stop", { chatId });
  }
  return true;
}

/**
 * Consume a teed SSE string stream into the buffer and fan it out to any
 * live GET subscribers. Safe to call after the original POST client is gone.
 */
export async function ingestSseStream(
  chatId: string,
  stream: ReadableStream<string>,
): Promise<void> {
  const entry = streams.get(chatId);
  if (!entry) {
    await stream.cancel().catch(() => undefined);
    return;
  }

  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const bytes = encoder.encode(value);
      entry.chunks.push(bytes);
      for (const subscriber of entry.subscribers) {
        try {
          subscriber.enqueue(bytes);
        } catch {
          entry.subscribers.delete(subscriber);
        }
      }
    }
  } catch {
    // Source failed or was aborted; still close followers below.
  } finally {
    reader.releaseLock();
    entry.done = true;
    for (const subscriber of entry.subscribers) {
      try {
        subscriber.close();
      } catch {
        // already closed
      }
    }
    entry.subscribers.clear();
    clearTimeout(entry.retainTimer);
    entry.retainTimer = setTimeout(() => {
      if (streams.get(chatId) === entry) streams.delete(chatId);
    }, RETAIN_MS);
    logInfo("stream-ingest-done", {
      chatId,
      chunks: entry.chunks.length,
      aborted: entry.abort.signal.aborted,
    });
  }
}

/**
 * Replay buffered SSE and, if the job is still running, follow live chunks.
 * Returns `null` when there is nothing to resume (caller should 204).
 */
export function resumeChatStream(chatId: string): Response | null {
  const entry = streams.get(chatId);
  if (!entry) return null;

  let subscriber: Subscriber | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of entry.chunks) {
        controller.enqueue(chunk);
      }
      if (entry.done) {
        controller.close();
        return;
      }
      subscriber = controller;
      entry.subscribers.add(controller);
    },
    cancel() {
      if (subscriber) entry.subscribers.delete(subscriber);
    },
  });

  return new Response(stream, { headers: UI_MESSAGE_STREAM_HEADERS });
}
