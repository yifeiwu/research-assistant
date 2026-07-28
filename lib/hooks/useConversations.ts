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
  messages: UIMessage[];
  setMessages: (messages: UIMessage[]) => void;
  isBusy: boolean;
  stop: () => void;
};

export type UseConversations = {
  conversations: Conversation[];
  activeId: string | null;
  restored: boolean;
  selectConversation: (id: string) => void;
  newConversation: () => void;
  deleteConversation: (id: string) => void;
};

/**
 * Manages multiple chat threads persisted in localStorage on top of the live
 * `useChat` message state. The active thread's messages live in `useChat`; this
 * hook mirrors them into the saved conversation list (debounced, once settled).
 */
export function useConversations({
  messages,
  setMessages,
  isBusy,
  stop,
}: UseConversationsArgs): UseConversations {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [restored, setRestored] = useState(false);

  // Ref mirror so the debounced persist callback always sees the latest id
  // without needing to be torn down/recreated on every change.
  const activeIdRef = useRef<string | null>(null);
  const setActive = useCallback((id: string | null) => {
    activeIdRef.current = id;
    setActiveId(id);
    saveActiveConversationId(id);
  }, []);

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
      activeIdRef.current = activeConv.id;
      setActiveId(activeConv.id);
      if (activeConv.messages.length > 0) setMessages(activeConv.messages);
    }

    setRestored(true);
  }, [setMessages]);

  // Persist the active thread once it's settled (not mid-stream). Debounced so a
  // burst of state updates only serializes the history once.
  useEffect(() => {
    if (!restored || isBusy) return;
    const handle = window.setTimeout(() => {
      if (messages.length === 0) return;

      let id = activeIdRef.current;
      if (!id) {
        id = createConversationId();
        setActive(id);
      }

      const now = Date.now();
      setConversations((prev) => {
        const existing = prev.find((c) => c.id === id);
        const title = existing?.title ?? deriveTitle(messages);
        const updated: Conversation = existing
          ? { ...existing, messages, title, updatedAt: now }
          : { id: id!, title, messages, createdAt: now, updatedAt: now };
        const next = [updated, ...prev.filter((c) => c.id !== id)];
        return saveConversations(next);
      });
    }, 500);
    return () => window.clearTimeout(handle);
  }, [messages, isBusy, restored, setActive]);

  const selectConversation = useCallback(
    (id: string) => {
      if (id === activeIdRef.current) return;
      if (isBusy) stop();
      const conv = conversations.find((c) => c.id === id);
      setActive(id);
      setMessages(conv?.messages ?? []);
    },
    [conversations, isBusy, stop, setActive, setMessages],
  );

  const newConversation = useCallback(() => {
    if (isBusy) stop();
    setActive(null);
    setMessages([]);
  }, [isBusy, stop, setActive, setMessages]);

  const deleteConversation = useCallback(
    (id: string) => {
      setConversations((prev) => {
        const next = prev.filter((c) => c.id !== id);
        saveConversations(next);
        return next;
      });
      if (activeIdRef.current === id) {
        if (isBusy) stop();
        setActive(null);
        setMessages([]);
      }
    },
    [isBusy, stop, setActive, setMessages],
  );

  return {
    conversations,
    activeId,
    restored,
    selectConversation,
    newConversation,
    deleteConversation,
  };
}
