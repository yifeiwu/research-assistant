"use client";

import { useCallback, useEffect, useRef } from "react";
import type { useChat } from "@ai-sdk/react";
import type { UIMessage } from "ai";

type ChatStatus = ReturnType<typeof useChat>["status"];

/**
 * Reconnects `useChat` to an Upstash Redis-backed SSE stream (`/api/chat/:id/stream`)
 * across three scenarios:
 *   1. Page reload while a conversation turn is still `pending`.
 *   2. Switching back to a background `pending` thread in the sidebar.
 *   3. Returning to a backgrounded tab (`visibilitychange` / `focus` / `online`)
 *      after the browser dropped the active fetch stream.
 *
 * `resumeStream()` always replays from chunk 0, so any partial trailing
 * assistant message is stripped before reconnecting (otherwise `text-start`
 * would append duplicate parts). On `204` (nothing in Redis), the snapshot is
 * restored and `pending` is cleared via `onNothingToResume`.
 */
export function useResumeOnVisible({
  chatId,
  status,
  messages,
  setMessages,
  resumeStream,
  userStoppedRef,
  isSeeded,
  activePending,
  onNothingToResume,
}: {
  chatId: string;
  status: ChatStatus;
  messages: UIMessage[];
  setMessages: (messages: UIMessage[]) => void;
  resumeStream: () => Promise<void>;
  userStoppedRef: React.RefObject<boolean>;
  isSeeded: boolean;
  activePending: boolean;
  onNothingToResume: (id: string, restoredMessages: UIMessage[]) => void;
}): void {
  const chatIdRef = useRef(chatId);
  const statusRef = useRef(status);
  const messagesRef = useRef(messages);
  const resumeRef = useRef(resumeStream);
  const setMessagesRef = useRef(setMessages);
  const activePendingRef = useRef(activePending);
  const onNothingToResumeRef = useRef(onNothingToResume);

  const inflightRef = useRef(false);
  const reconnectingChatIdRef = useRef<string | null>(null);
  const attemptedPendingChatIdRef = useRef<string | null>(null);

  useEffect(() => {
    chatIdRef.current = chatId;
    inflightRef.current = false;
    attemptedPendingChatIdRef.current = null;
  }, [chatId]);

  useEffect(() => {
    statusRef.current = status;
  }, [status]);
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);
  useEffect(() => {
    resumeRef.current = resumeStream;
  }, [resumeStream]);
  useEffect(() => {
    setMessagesRef.current = setMessages;
  }, [setMessages]);
  useEffect(() => {
    activePendingRef.current = activePending;
  }, [activePending]);
  useEffect(() => {
    onNothingToResumeRef.current = onNothingToResume;
  }, [onNothingToResume]);

  useEffect(() => {
    if (status === "submitted" || status === "streaming") {
      inflightRef.current = true;
      return;
    }
    if (userStoppedRef.current) {
      inflightRef.current = false;
      return;
    }
    // Completed while the tab is visible: nothing to reconnect to on focus.
    if (document.visibilityState === "visible") {
      inflightRef.current = false;
    }
    // If the tab is hidden, keep `inflight` so coming back triggers a resume.
  }, [status, userStoppedRef]);

  const reconnect = useCallback(
    async (targetChatId: string) => {
      if (document.visibilityState !== "visible") return;
      if (userStoppedRef.current) return;
      if (chatIdRef.current !== targetChatId) return;
      if (reconnectingChatIdRef.current === targetChatId) return;

      const current = statusRef.current;
      if (current === "streaming" || current === "submitted") return;

      const msgs = messagesRef.current;
      const last = msgs[msgs.length - 1];
      const snapshot = msgs;
      if (last?.role === "assistant") {
        setMessagesRef.current(msgs.slice(0, -1));
      }

      reconnectingChatIdRef.current = targetChatId;
      try {
        await resumeRef.current();
      } finally {
        if (reconnectingChatIdRef.current === targetChatId) {
          reconnectingChatIdRef.current = null;
        }
      }

      // User switched threads while `resumeStream()` was in flight; leave the
      // newly selected thread alone and keep the background thread pending.
      if (chatIdRef.current !== targetChatId) return;

      const afterStatus = statusRef.current;
      const afterMsgs = messagesRef.current;
      const afterLast = afterMsgs[afterMsgs.length - 1];
      const nothingReplayed =
        afterLast?.role !== "assistant" &&
        afterStatus !== "streaming" &&
        afterStatus !== "submitted";

      if (last?.role === "assistant" && nothingReplayed) {
        // GET 204: nothing to replay, restore what we stripped.
        setMessagesRef.current(snapshot);
      }

      if (
        nothingReplayed &&
        !userStoppedRef.current &&
        document.visibilityState === "visible"
      ) {
        onNothingToResumeRef.current(targetChatId, snapshot);
      }

      if (afterStatus !== "streaming" && afterStatus !== "submitted") {
        inflightRef.current = false;
      }
    },
    [userStoppedRef],
  );

  // Resume automatically when restoring from reload or selecting a pending
  // background thread in the sidebar once its messages have been seeded.
  useEffect(() => {
    if (!activePending) {
      if (attemptedPendingChatIdRef.current === chatId) {
        attemptedPendingChatIdRef.current = null;
      }
      return;
    }
    if (!isSeeded) return;
    if (document.visibilityState !== "visible") return;
    if (userStoppedRef.current) return;
    if (status === "streaming" || status === "submitted") return;
    if (attemptedPendingChatIdRef.current === chatId) return;

    attemptedPendingChatIdRef.current = chatId;
    void reconnect(chatId);
  }, [chatId, isSeeded, activePending, status, userStoppedRef, reconnect]);

  // Reconnect when returning to a backgrounded tab or recovering connectivity.
  useEffect(() => {
    function onVisible() {
      if (document.visibilityState !== "visible") return;
      if (userStoppedRef.current) return;
      if (!inflightRef.current && !activePendingRef.current) return;
      void reconnect(chatIdRef.current);
    }

    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    window.addEventListener("online", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
      window.removeEventListener("online", onVisible);
    };
  }, [chatId, userStoppedRef, reconnect]);
}
