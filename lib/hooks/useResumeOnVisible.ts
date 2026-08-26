"use client";

import { useEffect, useRef } from "react";
import type { useChat } from "@ai-sdk/react";
import type { UIMessage } from "ai";

type ChatStatus = ReturnType<typeof useChat>["status"];

/**
 * When a tab is backgrounded the browser often drops the fetch stream, which
 * looks like Stop. Generation continues server-side; this hook reconnects on
 * `visibilitychange` / focus and replays the buffered SSE.
 *
 * `resumeStream()` always replays from the start, so we drop a partial
 * assistant message before reconnecting (otherwise `text-start` would append a
 * duplicate part). If there is nothing to resume (204), we put the snapshot
 * back so a completed turn is not wiped.
 */
export function useResumeOnVisible({
  chatId,
  status,
  messages,
  setMessages,
  resumeStream,
  userStoppedRef,
}: {
  chatId: string;
  status: ChatStatus;
  messages: UIMessage[];
  setMessages: (messages: UIMessage[]) => void;
  resumeStream: () => Promise<void>;
  userStoppedRef: React.RefObject<boolean>;
}): void {
  const statusRef = useRef(status);
  const messagesRef = useRef(messages);
  const resumeRef = useRef(resumeStream);
  const setMessagesRef = useRef(setMessages);
  const inflightRef = useRef(false);

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
    if (status === "submitted" || status === "streaming") {
      inflightRef.current = true;
      return;
    }
    if (userStoppedRef.current) {
      inflightRef.current = false;
      return;
    }
    // Completed while the tab is visible: nothing to reconnect to.
    if (document.visibilityState === "visible") {
      inflightRef.current = false;
    }
    // If the tab is hidden, keep `inflight` so coming back triggers a resume.
  }, [status, userStoppedRef]);

  useEffect(() => {
    async function reconnect() {
      if (document.visibilityState !== "visible") return;
      if (userStoppedRef.current) return;
      if (!inflightRef.current) return;

      const current = statusRef.current;
      if (current === "streaming" || current === "submitted") return;

      const msgs = messagesRef.current;
      const last = msgs[msgs.length - 1];
      const snapshot = msgs;
      if (last?.role === "assistant") {
        setMessagesRef.current(msgs.slice(0, -1));
      }

      await resumeRef.current();

      const afterStatus = statusRef.current;
      const afterMsgs = messagesRef.current;
      const afterLast = afterMsgs[afterMsgs.length - 1];
      if (
        last?.role === "assistant" &&
        afterLast?.role !== "assistant" &&
        afterStatus !== "streaming" &&
        afterStatus !== "submitted"
      ) {
        // GET 204: nothing to replay, restore what we stripped.
        setMessagesRef.current(snapshot);
      }
      if (afterStatus !== "streaming" && afterStatus !== "submitted") {
        inflightRef.current = false;
      }
    }

    function onVisible() {
      void reconnect();
    }

    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, [chatId, userStoppedRef]);
}
