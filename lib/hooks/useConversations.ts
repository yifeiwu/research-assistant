"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { UIMessage } from "ai";
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

type UseConversationsArgs = {
  chatId: string;
  setChatId: (id: string) => void;
  messages: UIMessage[];
  setMessages: (messages: UIMessage[]) => void;
  isBusy: boolean;
  /** Detach the client fetch without cancelling server-side Redis generation. */
  detach: () => void;
  /** Explicitly cancel server-side generation for a thread (e.g. on delete). */
  stopServer: (id: string) => void;
};

export type UseConversations = {
  conversations: Conversation[];
  activeId: string;
  activePending: boolean;
  restored: boolean;
  isSeeded: boolean;
  selectConversation: (id: string) => void;
  newConversation: () => void;
  deleteConversation: (id: string) => void;
  settleConversation: (id: string, finalMessages?: UIMessage[]) => void;
};

/**
 * Manages multiple chat threads persisted in localStorage on top of the live
 * `useChat` message state.
 *
 * When a user turn starts (`isBusy`), the prompt messages are persisted
 * immediately with `pending: true` so reloading the page or switching threads
 * preserves the `chatId` and reconnects to Upstash Redis via
 * `GET /api/chat/:id/stream`. Switching threads detaches only the local fetch
 * so background threads continue generating server-side.
 */
export function useConversations({
  chatId,
  setChatId,
  messages,
  setMessages,
  isBusy,
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

  const setActive = useCallback(
    (id: string) => {
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
    // Only on mount: `setActive` is stable enough, and re-running would clobber
    // the live thread.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
  }, [isSeeded, isBusy, messages]);

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
      const target = conversationsRef.current.find((c) => c.id === id);
      const isCurrent = chatIdRef.current === id;

      if ((isCurrent && isBusy) || target?.pending) {
        stopServer(id);
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
    [isBusy, detach, stopServer, setActive],
  );

  const activePending = Boolean(
    conversations.find((c) => c.id === chatId)?.pending,
  );

  return {
    conversations,
    activeId: chatId,
    activePending,
    restored,
    isSeeded,
    selectConversation,
    newConversation,
    deleteConversation,
    settleConversation,
  };
}
