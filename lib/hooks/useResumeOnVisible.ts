"use client";

import { useCallback, useEffect, useRef } from "react";
import type { useChat } from "@ai-sdk/react";
import type { UIMessage } from "ai";

type ChatStatus = ReturnType<typeof useChat>["status"];

export type ReconnectOutcome =
  | "replayed"
  /** Replayed, but the stream ended before the turn did. */
  | "unfinished"
  | "empty"
  | "aborted"
  | "network-error"
  | "error"
  | null;

/**
 * How often in a row a reconnect whose stream ended before its turn did is
 * followed by another, and how long to wait before each.
 */
const MAX_UNFINISHED_RECONNECTS = 4;
const UNFINISHED_RECONNECT_DELAY_MS = 500;

/**
 * Reconnects `useChat` to an Upstash Redis-backed SSE stream (`/api/chat/:id/stream`)
 * across four scenarios:
 *   1. Page reload while a conversation turn is still `pending`.
 *   2. Switching back to a background `pending` thread in the sidebar.
 *   3. Returning to a backgrounded tab (`visibilitychange` / `focus` / `online`)
 *      after the browser dropped the active fetch stream.
 *   4. The server ending a stream before the turn is over, because the
 *      request behind it could not carry the turn further. The turn waits
 *      for the next request to tail it, so reconnecting is what continues it.
 *
 * `resumeStream()` always replays from chunk 0, so any partial trailing
 * assistant message is stripped before reconnecting. Instead of inspecting
 * React-lagged refs after `resumeStream()` resolves, we read the exact HTTP
 * reconnect outcome (`204` -> `"empty"` vs `200` -> `"replayed"`) captured by
 * the transport fetch wrapper so fast single-batch replays can never be
 * misclassified as empty and overwritten.
 */
export function useResumeOnVisible({
  chatId,
  status,
  messages,
  setMessages,
  resumeStream,
  consumeReconnectOutcome,
  isStopped,
  isSeeded,
  activePending,
  onNothingToResume,
  onResumeStart,
}: {
  chatId: string;
  status: ChatStatus;
  messages: UIMessage[];
  setMessages: (messages: UIMessage[]) => void;
  resumeStream: () => Promise<void>;
  consumeReconnectOutcome: () => ReconnectOutcome;
  isStopped: (id: string) => boolean;
  isSeeded: boolean;
  activePending: boolean;
  onNothingToResume: (id: string, restoredMessages: UIMessage[]) => void;
  onResumeStart?: (id: string) => void;
}): void {
  const chatIdRef = useRef(chatId);
  const statusRef = useRef(status);
  const messagesRef = useRef(messages);
  const resumeRef = useRef(resumeStream);
  const consumeOutcomeRef = useRef(consumeReconnectOutcome);
  const setMessagesRef = useRef(setMessages);
  const activePendingRef = useRef(activePending);
  const onNothingToResumeRef = useRef(onNothingToResume);

  const inflightRef = useRef(false);
  const reconnectingChatIdRef = useRef<string | null>(null);
  const attemptedPendingChatIdRef = useRef<string | null>(null);
  const unfinishedReconnectsRef = useRef(0);
  const unfinishedTimerRef = useRef<number | null>(null);
  const reconnectRef = useRef<(id: string) => Promise<void>>(async () => {});

  // Keep refs updated synchronously during render so callbacks never observe a
  // pre-commit value.
  chatIdRef.current = chatId;
  statusRef.current = status;
  messagesRef.current = messages;
  resumeRef.current = resumeStream;
  consumeOutcomeRef.current = consumeReconnectOutcome;
  setMessagesRef.current = setMessages;
  activePendingRef.current = activePending;
  onNothingToResumeRef.current = onNothingToResume;

  useEffect(() => {
    inflightRef.current = false;
    attemptedPendingChatIdRef.current = null;
    unfinishedReconnectsRef.current = 0;
    return () => {
      if (unfinishedTimerRef.current !== null) {
        window.clearTimeout(unfinishedTimerRef.current);
        unfinishedTimerRef.current = null;
      }
    };
  }, [chatId]);

  useEffect(() => {
    if (status === "submitted" || status === "streaming") {
      inflightRef.current = true;
      return;
    }
    if (isStopped(chatId)) {
      inflightRef.current = false;
      return;
    }
    // Completed while the tab is visible: nothing to reconnect to on focus.
    if (document.visibilityState === "visible") {
      inflightRef.current = false;
    }
    // If the tab is hidden, keep `inflight` so coming back triggers a resume.
  }, [chatId, status, isStopped]);

  const reconnect = useCallback(
    async (targetChatId: string) => {
      if (document.visibilityState !== "visible") return;
      if (isStopped(targetChatId)) return;
      if (chatIdRef.current !== targetChatId) return;
      if (reconnectingChatIdRef.current === targetChatId) return;

      const current = statusRef.current;
      if (current === "streaming" || current === "submitted") return;

      const snapshot = messagesRef.current;
      const hadTrailingAssistant =
        snapshot[snapshot.length - 1]?.role === "assistant";
      if (hadTrailingAssistant) {
        setMessagesRef.current(snapshot.slice(0, -1));
      }

      reconnectingChatIdRef.current = targetChatId;
      onResumeStart?.(targetChatId);
      try {
        await resumeRef.current();
      } finally {
        if (reconnectingChatIdRef.current === targetChatId) {
          reconnectingChatIdRef.current = null;
        }
      }

      // User switched threads while `resumeStream()` was in flight; leave the
      // newly selected thread untouched.
      if (chatIdRef.current !== targetChatId) return;

      const outcome = consumeOutcomeRef.current();

      if (outcome === "unfinished") {
        // The turn is still pending and waits for a request to continue it.
        // The limit is for a server that keeps cutting streams short; past
        // it, returning to the tab reconnects again.
        inflightRef.current = true;
        if (unfinishedReconnectsRef.current < MAX_UNFINISHED_RECONNECTS) {
          unfinishedReconnectsRef.current += 1;
          unfinishedTimerRef.current = window.setTimeout(() => {
            unfinishedTimerRef.current = null;
            void reconnectRef.current(targetChatId);
          }, UNFINISHED_RECONNECT_DELAY_MS);
        }
        return;
      }
      unfinishedReconnectsRef.current = 0;

      if (outcome === "empty") {
        // Authoritative HTTP 204: nothing in Redis to replay.
        if (hadTrailingAssistant) {
          setMessagesRef.current(snapshot);
        }
        if (!isStopped(targetChatId)) {
          onNothingToResumeRef.current(targetChatId, snapshot);
        }
        inflightRef.current = false;
        return;
      }

      if (outcome === "network-error") {
        // Transient network failure while reconnecting: restore snapshot and
        // keep `pending` / `inflight` so `online` / `focus` retries.
        if (hadTrailingAssistant) {
          setMessagesRef.current(snapshot);
        }
        inflightRef.current = true;
        return;
      }

      if (outcome === "error") {
        if (hadTrailingAssistant) {
          setMessagesRef.current(snapshot);
        }
        if (!isStopped(targetChatId)) {
          onNothingToResumeRef.current(targetChatId, snapshot);
        }
        inflightRef.current = false;
        return;
      }

      // `outcome === "replayed"` or `"aborted"`: `Chat.onFinish` already
      // received the authoritative final `messages` from `Chat.state`.
      if (
        statusRef.current !== "streaming" &&
        statusRef.current !== "submitted"
      ) {
        inflightRef.current = false;
      }
    },
    [isStopped, onResumeStart],
  );
  // For the timer above, which cannot name `reconnect` from inside it.
  useEffect(() => {
    reconnectRef.current = reconnect;
  }, [reconnect]);

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
    if (isStopped(chatId)) return;
    if (status === "streaming" || status === "submitted") return;
    if (attemptedPendingChatIdRef.current === chatId) return;

    attemptedPendingChatIdRef.current = chatId;
    void reconnect(chatId);
  }, [chatId, isSeeded, activePending, status, isStopped, reconnect]);

  // Reconnect when returning to a backgrounded tab or recovering connectivity.
  useEffect(() => {
    function onVisible() {
      if (document.visibilityState !== "visible") return;
      if (isStopped(chatIdRef.current)) return;
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
  }, [chatId, isStopped, reconnect]);
}
