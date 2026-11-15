import { Chat } from "@ai-sdk/react";
import { DefaultChatTransport, type UIMessage } from "ai";
import { fetchWithRetryAfter } from "@/lib/retry-fetch";
import type { ReconnectOutcome, StreamEnd } from "@/lib/turn-machine";
import { failIfUnfinished } from "@/lib/unfinished-stream";

/** How a request's stream ended, with the messages the chat was left with. */
export type SessionStreamEnd = StreamEnd & { messages: UIMessage[] };

/**
 * One thread's connection to the server: its `Chat`, and what only the
 * transport can see about how its requests went.
 */
export type ChatSession = {
  chat: Chat<UIMessage>;
  /** Replace the chat's messages. */
  setMessages: (messages: UIMessage[]) => void;
  /** Give up a reconnect request that is in flight, if there is one. */
  abortReconnect: () => void;
  /** How the last reconnect request ended. Reading it clears it. */
  consumeReconnectOutcome: () => ReconnectOutcome;
  /**
   * Listen for the end of each request's stream: a turn's own, or the replay
   * a reconnect gets. Returns the function that stops listening.
   */
  onStreamEnd: (listener: (end: SessionStreamEnd) => void) => () => void;
};

function isNetworkError(err: unknown): boolean {
  return err instanceof TypeError && /fetch|network|load failed/i.test(err.message);
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.href : input.url;
}

/**
 * A `Chat` for one thread, isolated from every other thread's:
 *
 * 1. Its callbacks belong to this thread for good, so nothing that arrives
 *    late can be taken for another thread's after a switch in the sidebar.
 * 2. Reconnect requests (`GET /api/chat/:id/stream`, sent by
 *    `chat.resumeStream()`) can be aborted, which the AI SDK does not offer,
 *    and report how they ended: the SDK tells an empty answer (204) from a
 *    replay only by what happens to its state afterwards.
 * 3. A stream that ends before its turn does is failed as a dropped
 *    connection (lib/unfinished-stream.ts), so the SDK never takes a turn
 *    the server handed on for one that is complete.
 */
export function createChatSession(
  chatId: string,
  opts?: { fetch?: typeof globalThis.fetch },
): ChatSession {
  const doFetch: typeof globalThis.fetch = (input, init) =>
    (opts?.fetch ?? globalThis.fetch)(input, init);

  let reconnectController: AbortController | null = null;
  let reconnectOutcome: ReconnectOutcome = null;
  let lastErrorWasNetwork = false;
  const listeners = new Set<(end: SessionStreamEnd) => void>();

  const abortReconnect = () => {
    reconnectController?.abort();
    reconnectController = null;
  };

  const reconnect = async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    abortReconnect();
    const controller = new AbortController();
    reconnectController = controller;
    reconnectOutcome = null;
    try {
      const response = await doFetch(input, { ...init, signal: controller.signal });
      reconnectOutcome =
        response.status === 204 ? "empty" : response.ok ? "replayed" : "error";
      // Known only once the replay has been read to its end.
      return failIfUnfinished(response, () => {
        reconnectOutcome = "unfinished";
      });
    } catch (err) {
      reconnectOutcome = controller.signal.aborted
        ? "aborted"
        : isNetworkError(err)
          ? "network-error"
          : "error";
      throw err;
    }
  };

  const transport = new DefaultChatTransport({
    api: "/api/chat",
    fetch: async (input, init) => {
      lastErrorWasNetwork = false;
      const method = (init?.method ?? "GET").toUpperCase();
      if (method === "GET" && requestUrl(input).includes("/stream")) {
        return reconnect(input, init);
      }
      // A 429 with a short Retry-After (per-visitor limit, or a full
      // research queue) is retried once here instead of becoming an error.
      const response = await fetchWithRetryAfter(doFetch, input, init);
      return failIfUnfinished(response);
    },
  });

  const chat = new Chat<UIMessage>({
    id: chatId,
    transport,
    onError: (err) => {
      lastErrorWasNetwork = isNetworkError(err);
    },
    onFinish: ({ messages, isAbort, isDisconnect, isError }) => {
      const end: SessionStreamEnd = {
        messages,
        isAbort,
        isError,
        networkDrop: isDisconnect || lastErrorWasNetwork,
      };
      lastErrorWasNetwork = false;
      for (const listener of [...listeners]) listener(end);
    },
  });

  return {
    chat,
    setMessages: (messages) => {
      chat.messages = messages;
    },
    abortReconnect,
    consumeReconnectOutcome: () => {
      const outcome = reconnectOutcome;
      reconnectOutcome = null;
      return outcome;
    },
    onStreamEnd: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
