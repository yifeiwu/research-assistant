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
  stop: () => void;
};

export type UseConversations = {
  conversations: Conversation[];
  activeId: string;
  restored: boolean;
  selectConversation: (id: string) => void;
  newConversation: () => void;
  deleteConversation: (id: string) => void;
};

/**
 * Manages multiple chat threads persisted in localStorage on top of the live
 * `useChat` message state. The active thread's messages live in `useChat`; this
 * hook mirrors them into the saved conversation list (debounced, once settled).
 *
 * `chatId` is owned by the page so `useChat({ id })` and the resume GET
 * (`/api/chat/:id/stream`) share the same key.
 */
export function useConversations({
  chatId,
  setChatId,
  messages,
  setMessages,
  isBusy,
  stop,
}: UseConversationsArgs): UseConversations {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [restored, setRestored] = useState(false);

  const chatIdRef = useRef(chatId);
  useEffect(() => {
    chatIdRef.current = chatId;
  }, [chatId]);

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
  // saved copy. Intentionally not dependent on `conversations` so a persist
  // write cannot overwrite an in-progress turn.
  useEffect(() => {
    if (!restored) return;
    const conv = conversations.find((c) => c.id === chatId);
    setMessages(conv?.messages ?? []);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [restored, chatId, setMessages]);

  // Persist the active thread once it's settled (not mid-stream). Debounced so a
  // burst of state updates only serializes the history once.
  useEffect(() => {
    if (!restored || isBusy) return;
    const handle = window.setTimeout(() => {
      if (messages.length === 0) return;

      const id = chatIdRef.current;
      const now = Date.now();
      setConversations((prev) => {
        const existing = prev.find((c) => c.id === id);
        const title = existing?.title ?? deriveTitle(messages);
        const updated: Conversation = existing
          ? { ...existing, messages, title, updatedAt: now }
          : { id, title, messages, createdAt: now, updatedAt: now };
        const next = [updated, ...prev.filter((c) => c.id !== id)];
        return saveConversations(next);
      });
    }, 500);
    return () => window.clearTimeout(handle);
  }, [messages, isBusy, restored]);

  const selectConversation = useCallback(
    (id: string) => {
      if (id === chatIdRef.current) return;
      if (isBusy) stop();
      setActive(id);
    },
    [isBusy, stop, setActive],
  );

  const newConversation = useCallback(() => {
    if (isBusy) stop();
    setActive(createConversationId());
  }, [isBusy, stop, setActive]);

  const deleteConversation = useCallback(
    (id: string) => {
      setConversations((prev) => {
        const next = prev.filter((c) => c.id !== id);
        saveConversations(next);
        return next;
      });
      if (chatIdRef.current === id) {
        if (isBusy) stop();
        setActive(createConversationId());
      }
    },
    [isBusy, stop, setActive],
  );

  return {
    conversations,
    activeId: chatId,
    restored,
    selectConversation,
    newConversation,
    deleteConversation,
  };
}
