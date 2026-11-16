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
  saveActiveConversationId,
  saveConversations,
  withTurnPrompt,
} from "@/lib/conversations";
import { findLastUserMessageId } from "@/lib/messages";
import { isPending, type ThreadTurn, type TurnEvent } from "@/lib/turn-machine";

const BG_POLL_INTERVAL_MS = 3_000;
/** How long a deleted conversation can be brought back. */
const UNDO_DELETE_MS = 6_000;

type UndoableDelete = {
  conversation: Conversation;
  /** It was the open thread, so undoing reopens it. */
  wasActive: boolean;
  /** Set when a turn was generating: stop it once the delete is final. */
  stop?: { turnId?: string };
  timer: number;
};

type UseConversationsArgs = {
  chatId: string;
  /** Open a thread with its saved initial messages, if any. */
  setChatId: (id: string, initialMessages?: UIMessage[]) => void;
  messages: UIMessage[];
  setMessages: (messages: UIMessage[]) => void;
  isBusy: boolean;
  /** The open thread's turn (lib/turn-machine.ts). */
  activeTurn: ThreadTurn | undefined;
  /** A thread's turn as of right now, for code that runs between renders. */
  getTurn: (id: string) => ThreadTurn | undefined;
  /** Tell the turn machine what this hook learns about turns. */
  dispatchTurn: (event: TurnEvent) => void;
  /** Detach the client fetch/reconnect stream without cancelling server Redis generation. */
  detach: () => void;
  /** Explicitly cancel server-side generation for a thread (e.g. on delete). */
  stopServer: (id: string, turnId?: string) => void;
};

export type UseConversations = {
  conversations: Conversation[];
  activeId: string;
  isSeeded: boolean;
  selectConversation: (id: string) => void;
  newConversation: () => void;
  /** Removes a conversation; `undoDelete` brings it back while `deleted` is set. */
  deleteConversation: (id: string) => void;
  deleted: { id: string; title: string } | null;
  undoDelete: () => void;
  settleConversation: (id: string, finalMessages?: UIMessage[]) => void;
};

type BackgroundPollResult =
  | { state: "running" }
  | { state: "empty" }
  | { state: "retry" }
  | { state: "done"; assistantMessage: UIMessage }
  | { state: "stale"; assistantMessage: UIMessage };

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
 * Manages multiple chat threads persisted in localStorage, plus background
 * collection of finished `pending` threads while the user works in another
 * conversation.
 */
export function useConversations({
  chatId,
  setChatId,
  messages,
  setMessages,
  isBusy,
  activeTurn,
  getTurn,
  dispatchTurn,
  detach,
  stopServer,
}: UseConversationsArgs): UseConversations {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [restored, setRestored] = useState(false);

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
    (id: string, initialMessages?: UIMessage[]) => {
      const bgCtrl = bgControllersRef.current.get(id);
      if (bgCtrl) {
        bgCtrl.abort();
        bgControllersRef.current.delete(id);
      }
      const seeded =
        initialMessages ?? conversationsRef.current.find((c) => c.id === id)?.messages;
      chatIdRef.current = id;
      setChatId(id, seeded);
      saveActiveConversationId(id);
    },
    [setChatId],
  );

  // Hydrate saved conversations after initial SSR-matching render.
  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      const list = loadConversations();
      const active = loadActiveConversationId();

      conversationsRef.current = list;
      setConversations(list);
      dispatchTurn({
        type: "HYDRATE",
        pending: list
          .filter((c) => c.pending)
          .map((c) => ({ chatId: c.id, since: c.pendingSince })),
      });

      const activeConv = active ? list.find((c) => c.id === active) : undefined;
      if (activeConv) {
        if (activeConv.id === chatIdRef.current) {
          setMessages(activeConv.messages);
        } else {
          setActive(activeConv.id, activeConv.messages);
        }
      } else {
        saveActiveConversationId(chatIdRef.current);
      }

      setRestored(true);
    });
    return () => {
      cancelled = true;
    };
  }, [dispatchTurn, setActive, setMessages]);

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

  // Immediately persist user turns as `pending: true` when generation starts so
  // reloads, tab closes, and thread switches can resume from Upstash Redis.
  const turnPending = isPending(activeTurn?.phase);
  useEffect(() => {
    if (!restored || !isBusy || !turnPending || messages.length === 0) return;

    const id = chatId;
    const last = messages[messages.length - 1];
    const promptMessages =
      last?.role === "assistant" ? messages.slice(0, -1) : messages;
    if (promptMessages.length === 0) return;
    const lastPromptId = promptMessages[promptMessages.length - 1]?.id;

    const current = conversationsRef.current.find((c) => c.id === id);
    if (
      current?.pending &&
      current.messages.length === promptMessages.length &&
      current.messages[current.messages.length - 1]?.id === lastPromptId
    ) {
      return;
    }

    setConversations((prev) => {
      const updated = withTurnPrompt(prev, id, promptMessages, getTurn(id), Date.now());
      if (!updated) return prev;
      const next = saveConversations(updated);
      conversationsRef.current = next;
      return next;
    });
  }, [chatId, restored, isBusy, turnPending, messages, getTurn]);

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
                pendingSince: undefined,
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
          prev.map((c) =>
            c.id === id ? { ...c, pending: false, pendingSince: undefined } : c,
          ),
        );
        conversationsRef.current = next;
        return next;
      });
    },
    [],
  );

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
              dispatchTurn({ type: "COLLECTED", chatId: conv.id });
            } else if (res.state === "empty") {
              settleConversation(conv.id);
              dispatchTurn({ type: "RESUME_EMPTY", chatId: conv.id });
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
  }, [restored, hasBackgroundPending, settleConversation, dispatchTurn]);

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

  const undoableDeleteRef = useRef<UndoableDelete | null>(null);
  const [deleted, setDeleted] = useState<{ id: string; title: string } | null>(
    null,
  );

  const commitDelete = useCallback(() => {
    const entry = undoableDeleteRef.current;
    if (!entry) return;
    window.clearTimeout(entry.timer);
    undoableDeleteRef.current = null;
    setDeleted(null);
    if (entry.stop) stopServer(entry.conversation.id, entry.stop.turnId);
  }, [stopServer]);

  useEffect(() => {
    window.addEventListener("pagehide", commitDelete);
    return () => {
      window.removeEventListener("pagehide", commitDelete);
      commitDelete();
    };
  }, [commitDelete]);

  const deleteConversation = useCallback(
    (id: string) => {
      commitDelete();

      const bgCtrl = bgControllersRef.current.get(id);
      if (bgCtrl) {
        bgCtrl.abort();
        bgControllersRef.current.delete(id);
      }

      const target = conversationsRef.current.find((c) => c.id === id);
      const isCurrent = chatIdRef.current === id;

      const generating = (isCurrent && isBusy) || Boolean(target?.pending);
      const stop = generating
        ? {
            turnId: findLastUserMessageId(
              isCurrent ? messages : (target?.messages ?? []),
            ),
          }
        : undefined;

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
      dispatchTurn({ type: "FORGET", chatId: id });

      if (!target) {
        if (stop) stopServer(id, stop.turnId);
        return;
      }
      undoableDeleteRef.current = {
        conversation: target,
        wasActive: isCurrent,
        stop,
        timer: window.setTimeout(commitDelete, UNDO_DELETE_MS),
      };
      setDeleted({ id, title: target.title });
    },
    [isBusy, messages, detach, stopServer, setActive, commitDelete, dispatchTurn],
  );

  const undoDelete = useCallback(() => {
    const entry = undoableDeleteRef.current;
    if (!entry) return;
    window.clearTimeout(entry.timer);
    undoableDeleteRef.current = null;
    setDeleted(null);

    const { conversation } = entry;
    setConversations((prev) => {
      const next = saveConversations([
        conversation,
        ...prev.filter((c) => c.id !== conversation.id),
      ]);
      conversationsRef.current = next;
      return next;
    });
    dispatchTurn({
      type: "RESTORE",
      chatId: conversation.id,
      pending: Boolean(conversation.pending),
      since: conversation.pendingSince,
    });
    if (entry.wasActive && chatIdRef.current !== conversation.id) {
      if (isBusy) detach();
      setActive(conversation.id, conversation.messages);
    }
  }, [isBusy, detach, setActive, dispatchTurn]);

  return {
    conversations,
    activeId: chatId,
    isSeeded: restored,
    selectConversation,
    newConversation,
    deleteConversation,
    deleted,
    undoDelete,
    settleConversation,
  };
}
