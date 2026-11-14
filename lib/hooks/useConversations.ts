"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  parseJsonEventStream,
  readUIMessageStream,
  uiMessageChunkSchema,
  type UIMessage,
  type UIMessageChunk,
} from "ai";
import {
  type Conversation,
  createConversationId,
  deriveTitle,
  loadActiveConversationId,
  loadConversations,
  migrateLegacyMessages,
  saveActiveConversationId,
  saveConversations,
} from "@/lib/conversations";
import { findLastUserMessageId } from "@/lib/messages";

const BG_POLL_INTERVAL_MS = 3_000;

type UseConversationsArgs = {
  chatId: string;
  setChatId: (id: string) => void;
  messages: UIMessage[];
  setMessages: (messages: UIMessage[]) => void;
  isBusy: boolean;
  isStopped: (id: string) => boolean;
  /** Detach the client fetch/reconnect stream without cancelling server Redis generation. */
  detach: () => void;
  /** Explicitly cancel server-side generation for a thread (e.g. on delete). */
  stopServer: (id: string, turnId?: string) => void;
};

export type UseConversations = {
  conversations: Conversation[];
  activeId: string;
  activePending: boolean;
  isSeeded: boolean;
  selectConversation: (id: string) => void;
  newConversation: () => void;
  deleteConversation: (id: string) => void;
  settleConversation: (id: string, finalMessages?: UIMessage[]) => void;
};

type BackgroundPollResult =
  | { state: "running" }
  | { state: "empty" }
  | { state: "retry" }
  | { state: "done"; assistantMessage: UIMessage }
  | { state: "stale"; assistantMessage: UIMessage };

/**
 * Non-blocking check for a background `pending` thread (`?onlyDone=1`).
 * Returns `running` (HTTP 202) with zero body transfer while the server is
 * still streaming, and reconstructs the final `UIMessage` once done (HTTP 200)
 * so background threads persist before Redis's 10-minute TTL expires.
 */
async function pollBackgroundConversation(
  id: string,
  signal: AbortSignal,
): Promise<BackgroundPollResult> {
  const response = await fetch(`/api/chat/${id}/stream?onlyDone=1`, {
    method: "GET",
    signal,
  });

  if (response.status === 202) return { state: "running" };
  if (response.status === 204) return { state: "empty" };
  if (!response.ok || !response.body) return { state: "retry" };
  const isStale = response.headers.get("x-chat-stream-stale") === "1";

  const chunkStream = parseJsonEventStream({
    stream: response.body,
    schema: uiMessageChunkSchema,
  }).pipeThrough(
    new TransformStream({
      transform(part, controller) {
        if (part.success) {
          controller.enqueue(part.value as UIMessageChunk);
        }
      },
    }),
  );

  let assistantMessage: UIMessage | undefined;
  for await (const msg of readUIMessageStream({ stream: chunkStream })) {
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    assistantMessage = msg;
  }

  if (!assistantMessage) return { state: "empty" };
  return isStale
    ? { state: "stale", assistantMessage }
    : { state: "done", assistantMessage };
}

/**
 * Manages multiple chat threads persisted in localStorage on top of the live
 * `useChat` message state, plus background collection of finished `pending`
 * threads while the user works in another conversation.
 */
export function useConversations({
  chatId,
  setChatId,
  messages,
  setMessages,
  isBusy,
  isStopped,
  detach,
  stopServer,
}: UseConversationsArgs): UseConversations {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [restored, setRestored] = useState(false);
  const [seededId, setSeededId] = useState<string | null>(null);

  const chatIdRef = useRef(chatId);
  useEffect(() => {
    chatIdRef.current = chatId;
  }, [chatId]);

  const conversationsRef = useRef(conversations);
  useEffect(() => {
    conversationsRef.current = conversations;
  }, [conversations]);

  const bgControllersRef = useRef<Map<string, AbortController>>(new Map());

  const setActive = useCallback(
    (id: string) => {
      // Abort any background poll for the thread becoming active so the live
      // `useResumeOnVisible` stream takes over without contention.
      const bgCtrl = bgControllersRef.current.get(id);
      if (bgCtrl) {
        bgCtrl.abort();
        bgControllersRef.current.delete(id);
      }
      chatIdRef.current = id;
      setChatId(id);
      saveActiveConversationId(id);
    },
    [setChatId],
  );

  // Restore saved conversations (migrating any legacy single-thread state).
  useEffect(() => {
    let list = loadConversations();
    let active = loadActiveConversationId();

    if (list.length === 0) {
      const migrated = migrateLegacyMessages();
      if (migrated) {
        list = [migrated];
        active = migrated.id;
        saveConversations(list);
        saveActiveConversationId(active);
      }
    }

    conversationsRef.current = list;
    setConversations(list);

    const activeConv = active ? list.find((c) => c.id === active) : undefined;
    if (activeConv) {
      setActive(activeConv.id);
    } else {
      saveActiveConversationId(chatIdRef.current);
    }

    setRestored(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Abort all in-flight background polls on unmount.
  useEffect(() => {
    const controllers = bgControllersRef.current;
    return () => {
      for (const ctrl of controllers.values()) {
        ctrl.abort();
      }
      controllers.clear();
    };
  }, []);

  // When the active thread changes (restore / sidebar), seed useChat from the
  // saved copy and mark `seededId` once applied so resume hooks wait for it.
  useEffect(() => {
    if (!restored) return;
    const conv = conversationsRef.current.find((c) => c.id === chatId);
    setMessages(conv?.messages ?? []);
    setSeededId(chatId);
  }, [restored, chatId, setMessages]);

  const isSeeded = restored && seededId === chatId;

  // Immediately persist user turns as `pending: true` when generation starts so
  // reloads, tab closes, and thread switches can resume from Upstash Redis.
  useEffect(() => {
    if (!isSeeded || !isBusy || messages.length === 0) return;

    const id = chatIdRef.current;
    if (isStopped(id)) return;
    const last = messages[messages.length - 1];
    const promptMessages =
      last?.role === "assistant" ? messages.slice(0, -1) : messages;
    if (promptMessages.length === 0) return;

    const lastPromptId = promptMessages[promptMessages.length - 1]?.id;

    setConversations((prev) => {
      const existing = prev.find((c) => c.id === id);
      const existingLastId =
        existing?.messages[existing.messages.length - 1]?.id;
      if (
        existing?.pending &&
        existing.messages.length === promptMessages.length &&
        existingLastId === lastPromptId
      ) {
        return prev;
      }

      const now = Date.now();
      const title = existing?.title ?? deriveTitle(promptMessages);
      const updated: Conversation = existing
        ? {
            ...existing,
            messages: promptMessages,
            title,
            pending: true,
            updatedAt: now,
          }
        : {
            id,
            title,
            messages: promptMessages,
            pending: true,
            createdAt: now,
            updatedAt: now,
          };
      const next = saveConversations([
        updated,
        ...prev.filter((c) => c.id !== id),
      ]);
      conversationsRef.current = next;
      return next;
    });
  }, [isSeeded, isBusy, messages, isStopped]);

  const settleConversation = useCallback(
    (id: string, finalMessages?: UIMessage[]) => {
      setConversations((prev) => {
        const existing = prev.find((c) => c.id === id);
        const now = Date.now();

        if (finalMessages && finalMessages.length > 0) {
          const title = existing?.title ?? deriveTitle(finalMessages);
          const updated: Conversation = existing
            ? {
                ...existing,
                messages: finalMessages,
                title,
                pending: false,
                updatedAt: now,
              }
            : {
                id,
                title,
                messages: finalMessages,
                pending: false,
                createdAt: now,
                updatedAt: now,
              };
          const next = saveConversations([
            updated,
            ...prev.filter((c) => c.id !== id),
          ]);
          conversationsRef.current = next;
          return next;
        }

        if (!existing?.pending) return prev;
        const next = saveConversations(
          prev.map((c) => (c.id === id ? { ...c, pending: false } : c)),
        );
        conversationsRef.current = next;
        return next;
      });
    },
    [],
  );

  // Background collector: periodically check non-active `pending` threads so
  // completed responses are saved to localStorage (and their sidebar indicators
  // clear) even if the user never switches back before Redis TTL expiry.
  const hasBackgroundPending = conversations.some(
    (c) => c.pending && c.id !== chatId,
  );

  useEffect(() => {
    if (!restored || !hasBackgroundPending) return;

    const checkPendingBackgroundThreads = () => {
      if (document.visibilityState !== "visible") return;
      const pendingBg = conversationsRef.current.filter(
        (c) => c.pending && c.id !== chatIdRef.current,
      );

      for (const conv of pendingBg) {
        if (bgControllersRef.current.has(conv.id)) continue;
        const ctrl = new AbortController();
        bgControllersRef.current.set(conv.id, ctrl);

        void pollBackgroundConversation(conv.id, ctrl.signal)
          .then((res) => {
            if (ctrl.signal.aborted || chatIdRef.current === conv.id) return;
            const latest = conversationsRef.current.find(
              (c) => c.id === conv.id,
            );
            if (!latest?.pending) return;

            if (res.state === "done" || res.state === "stale") {
              const last = latest.messages[latest.messages.length - 1];
              const base =
                last?.role === "assistant"
                  ? latest.messages.slice(0, -1)
                  : latest.messages;
              // A stale run's producer died mid-answer: keep the partial text
              // but disclose the interruption instead of presenting a
              // truncated answer as complete.
              const collected =
                res.state === "stale"
                  ? {
                      ...res.assistantMessage,
                      parts: [
                        ...res.assistantMessage.parts,
                        {
                          type: "text" as const,
                          text: "\n\n_This response was interrupted before it finished, so it may be incomplete._",
                        },
                      ],
                    }
                  : res.assistantMessage;
              settleConversation(conv.id, [...base, collected]);
            } else if (res.state === "empty") {
              settleConversation(conv.id);
            }
          })
          .catch(() => {
            // Network error or abort; retry on next tick if still pending.
          })
          .finally(() => {
            if (bgControllersRef.current.get(conv.id) === ctrl) {
              bgControllersRef.current.delete(conv.id);
            }
          });
      }
    };

    const initialTimer = window.setTimeout(
      checkPendingBackgroundThreads,
      1_000,
    );
    const interval = window.setInterval(
      checkPendingBackgroundThreads,
      BG_POLL_INTERVAL_MS,
    );
    document.addEventListener("visibilitychange", checkPendingBackgroundThreads);

    return () => {
      window.clearTimeout(initialTimer);
      window.clearInterval(interval);
      document.removeEventListener(
        "visibilitychange",
        checkPendingBackgroundThreads,
      );
    };
  }, [restored, hasBackgroundPending, settleConversation]);

  const selectConversation = useCallback(
    (id: string) => {
      if (id === chatIdRef.current) return;
      if (isBusy) detach();
      setActive(id);
    },
    [isBusy, detach, setActive],
  );

  const newConversation = useCallback(() => {
    if (isBusy) detach();
    setActive(createConversationId());
  }, [isBusy, detach, setActive]);

  const deleteConversation = useCallback(
    (id: string) => {
      const bgCtrl = bgControllersRef.current.get(id);
      if (bgCtrl) {
        bgCtrl.abort();
        bgControllersRef.current.delete(id);
      }

      const target = conversationsRef.current.find((c) => c.id === id);
      const isCurrent = chatIdRef.current === id;

      if ((isCurrent && isBusy) || target?.pending) {
        const turnId = findLastUserMessageId(
          isCurrent ? messages : (target?.messages ?? []),
        );
        stopServer(id, turnId);
      }

      setConversations((prev) => {
        const next = prev.filter((c) => c.id !== id);
        saveConversations(next);
        conversationsRef.current = next;
        return next;
      });

      if (isCurrent) {
        if (isBusy) detach();
        setActive(createConversationId());
      }
    },
    [isBusy, messages, detach, stopServer, setActive],
  );

  const activePending = Boolean(
    conversations.find((c) => c.id === chatId)?.pending,
  );

  return {
    conversations,
    activeId: chatId,
    activePending,
    isSeeded,
    selectConversation,
    newConversation,
    deleteConversation,
    settleConversation,
  };
}
