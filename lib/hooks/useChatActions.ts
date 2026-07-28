"use client";

import { useCallback, useEffect, useRef } from "react";
import type { useChat } from "@ai-sdk/react";
import { getMessageText } from "@/lib/messages";
import type { ChatRequestBody } from "@/lib/types/chat";

type UseChatHelpers = ReturnType<typeof useChat>;

type ChatActionsArgs = {
  messages: UseChatHelpers["messages"];
  setMessages: UseChatHelpers["setMessages"];
  sendMessage: UseChatHelpers["sendMessage"];
  isBusy: boolean;
  requestBody: () => ChatRequestBody;
};

export type ChatActions = {
  handleEditUser: (id: string, newText: string) => void;
  handleRegenerate: (assistantId: string) => void;
  handleRetry: () => void;
};

/**
 * Edit/regenerate actions for the conversation. Both truncate the thread at a
 * user message and resend. Callbacks have stable identity (reading live values
 * from refs) so Message memoization survives streaming.
 */
export function useChatActions({
  messages,
  setMessages,
  sendMessage,
  isBusy,
  requestBody,
}: ChatActionsArgs): ChatActions {
  // Keep the latest values accessible from the stable callbacks below without
  // re-creating them — which would break Message's memoization during streaming.
  const messagesRef = useRef(messages);
  const isBusyRef = useRef(isBusy);
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);
  useEffect(() => {
    isBusyRef.current = isBusy;
  }, [isBusy]);

  // Truncate the conversation at `userMessageId` (dropping it and everything
  // after) and resend, optionally with edited text. Powers both "edit" and
  // "regenerate".
  const resendFrom = useCallback(
    (userMessageId: string, newText?: string) => {
      if (isBusyRef.current) return;
      const msgs = messagesRef.current;
      const idx = msgs.findIndex((m) => m.id === userMessageId);
      if (idx === -1) return;
      const text = (newText ?? getMessageText(msgs[idx])).trim();
      if (!text) return;
      setMessages(msgs.slice(0, idx));
      sendMessage({ text }, { body: requestBody() });
    },
    [setMessages, sendMessage, requestBody],
  );

  const handleEditUser = useCallback(
    (id: string, newText: string) => resendFrom(id, newText),
    [resendFrom],
  );

  const handleRegenerate = useCallback(
    (assistantId: string) => {
      const msgs = messagesRef.current;
      const idx = msgs.findIndex((m) => m.id === assistantId);
      if (idx === -1) return;
      for (let i = idx - 1; i >= 0; i--) {
        if (msgs[i].role === "user") {
          resendFrom(msgs[i].id);
          return;
        }
      }
    },
    [resendFrom],
  );

  // Resend the most recent user message. Used to recover from a failed/errored
  // response (e.g. an intermittent model failure) without editing anything.
  const handleRetry = useCallback(() => {
    const msgs = messagesRef.current;
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].role === "user") {
        resendFrom(msgs[i].id);
        return;
      }
    }
  }, [resendFrom]);

  return { handleEditUser, handleRegenerate, handleRetry };
}
