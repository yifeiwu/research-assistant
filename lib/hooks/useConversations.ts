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
  /** Open a thread. */
  setChatId: (id: string) => void;
  messages: UIMessage[];
  setMessages: (messages: UIMessage[]) => void;
  isBusy: boolean;
  /** The open thread's turn (lib/turn-machine.ts). */
  activeTurn: ThreadTurn | undefined;
  /** A thread's turn as of right now, for code that runs between renders. */
  getTurn: (id: string) => ThreadTurn | undefined;
  /**
   * Tell the turn machine what this hook learns about turns: the ones found
   * pending in storage, the ones it collects in the background, and threads
   * that are deleted or brought back.
   */
  dispatchTurn: (event: TurnEvent) => void;
  /** Detach the client fetch/reconnect stream without cancelling server Redis generation. */
  detach: () => void;
  /** Explicitly cancel server-side generation for a thread (e.g. on delete). */
  stopServer: (id: string, turnId?: string) => void;
};

/**
 * A saved conversation's `pending` flag is the turn machine's state written
 * down, so that it survives a reload: set here when a turn is sent, cleared
 * by `settleConversation` when the machine says the turn is over, and read
 * back into the machine when the page loads. Nothing else decides it.
 */
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
  activeTurn,
  getTurn,
  dispatchTurn,
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
      // reconnect (`useReconnect`) takes over without contention.
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
    // Turns that were pending when the page was last open still are, as far
    // as anyone knows: each is reconnected to, or collected, to find out.
    dispatchTurn({
      type: "HYDRATE",
      pending: list
        .filter((c) => c.pending)
        .map((c) => ({ chatId: c.id, since: c.pendingSince })),
    });

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
  const turnPending = isPending(activeTurn?.phase);
  useEffect(() => {
    if (!isSeeded || !isBusy || !turnPending || messages.length === 0) return;

    // The thread these messages belong to: the one this render was for. Not
    // `chatIdRef`, which already names the next thread when another has just
    // been opened, and would have this one's prompt saved under that one.
    const id = chatId;
    const last = messages[messages.length - 1];
    const promptMessages =
      last?.role === "assistant" ? messages.slice(0, -1) : messages;
    if (promptMessages.length === 0) return;
    const lastPromptId = promptMessages[promptMessages.length - 1]?.id;

    // The usual case while a turn streams (this runs for every update to
    // its message): saved already, so no state update is even queued.
    const current = conversationsRef.current.find((c) => c.id === id);
    if (
      current?.pending &&
      current.messages.length === promptMessages.length &&
      current.messages[current.messages.length - 1]?.id === lastPromptId
    ) {
      return;
    }

    setConversations((prev) => {
      // An effect runs a little after the render it belongs to, and the
      // turn can be over by then. So how it stands is asked for now, not
      // taken from that render.
      const updated = withTurnPrompt(prev, id, promptMessages, getTurn(id), Date.now());
      if (!updated) return prev;
      const next = saveConversations(updated);
      conversationsRef.current = next;
      return next;
    });
  }, [chatId, isSeeded, isBusy, turnPending, messages, getTurn]);

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
              dispatchTurn({ type: "COLLECTED", chatId: conv.id });
            } else if (res.state === "empty") {
              // Nothing left of the turn on the server.
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

  // A deleted conversation can be brought back for a few seconds. It leaves
  // the list and storage at once; what cannot be taken back (stopping its
  // generation on the server) waits until the chance to undo has passed.
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

  // Leaving the page ends the chance to undo.
  useEffect(() => {
    window.addEventListener("pagehide", commitDelete);
    return () => {
      window.removeEventListener("pagehide", commitDelete);
      commitDelete();
    };
  }, [commitDelete]);

  const deleteConversation = useCallback(
    (id: string) => {
      // One undo at a time: an earlier delete becomes final.
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
        // Only lets go of the stream; the turn itself runs on for now.
        if (isBusy) detach();
        setActive(createConversationId());
      }
      dispatchTurn({ type: "FORGET", chatId: id });

      if (!target) {
        // Nothing saved to bring back.
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
    // A turn that was still generating was never stopped, so it is pending
    // again, and reconnected to or collected as usual.
    dispatchTurn({
      type: "RESTORE",
      chatId: conversation.id,
      pending: Boolean(conversation.pending),
      since: conversation.pendingSince,
    });
    // Back to where it was deleted from.
    if (entry.wasActive && chatIdRef.current !== conversation.id) {
      if (isBusy) detach();
      setActive(conversation.id);
    }
  }, [isBusy, detach, setActive, dispatchTurn]);

  return {
    conversations,
    activeId: chatId,
    isSeeded,
    selectConversation,
    newConversation,
    deleteConversation,
    deleted,
    undoDelete,
    settleConversation,
  };
}
