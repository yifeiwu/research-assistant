"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Chat } from "@ai-sdk/react";
import type { UIMessage } from "ai";

type ChatStatus = Chat<UIMessage>["status"];

type Snapshot<UI_MESSAGE extends UIMessage> = {
  chat: Chat<UI_MESSAGE>;
  messages: UI_MESSAGE[];
  status: ChatStatus;
  error: Error | undefined;
};

/**
 * Subscribe React state to an `@ai-sdk/react` `Chat` instance using `useState`
 * (`DefaultLane`) instead of `@ai-sdk/react`'s `useChat` (`useSyncExternalStore`
 * on `SyncLane`).
 *
 * Why this exists:
 * 1. **Eliminates React #185 (`Maximum update depth exceeded`) across all
 *    timers, polling, and streaming speeds:** `useSyncExternalStore` forces
 *    every store notification onto `SyncLane` (`2`). Whenever a periodic
 *    `DefaultLane` (`32`) state update (the 1s `useHeartbeat` timer, the 3s
 *    background `/api/chat/:id/stream?onlyDone=1` poll in `useConversations`,
 *    or scroll state) is pending while the scheduler's `MessageChannel` is
 *    delayed or background-throttled, React 19 sees `remainingLanes & 42 !== 0`
 *    after each `SyncLane` commit and increments `nestedUpdateCount++` — even
 *    with `experimental_throttle: 50` (since chunks >50ms apart still fire
 *    synchronously in `throttleit`). Scheduling chat updates via `useState`
 *    keeps them in `DefaultLane`, batching cleanly with timer/poll updates and
 *    never running synchronous React commits inside `AbstractChat`'s stream
 *    writer.
 * 2. **Re-subscribes `status` and `error` on thread switch:** `@ai-sdk/react`'s
 *    `useChat` passes `chatRef.current["~registerStatusCallback"]` directly to
 *    `useSyncExternalStore` without re-creating the `subscribe` function when
 *    `options.chat` changes, leaving `status` and `error` subscribed to the
 *    initial `Chat` instance after switching threads or starting a new chat.
 */
export function useChatState<UI_MESSAGE extends UIMessage = UIMessage>(
  chat: Chat<UI_MESSAGE>,
  throttleMs?: number,
) {
  const [snapshot, setSnapshot] = useState<Snapshot<UI_MESSAGE>>(() => ({
    chat,
    messages: chat.messages,
    status: chat.status,
    error: chat.error,
  }));

  // Synchronously reflect a newly selected `Chat` instance on the first render
  // after `chatId` changes so consumers never read the previous thread's state.
  let current = snapshot;
  if (snapshot.chat !== chat) {
    current = {
      chat,
      messages: chat.messages,
      status: chat.status,
      error: chat.error,
    };
    setSnapshot(current);
  }

  useEffect(() => {
    let active = true;
    const sync = () => {
      if (!active) return;
      setSnapshot((prev) => {
        if (
          prev.chat === chat &&
          prev.messages === chat.messages &&
          prev.status === chat.status &&
          prev.error === chat.error
        ) {
          return prev;
        }
        return {
          chat,
          messages: chat.messages,
          status: chat.status,
          error: chat.error,
        };
      });
    };

    // Catch any mutation that occurred between render and passive effect mount.
    sync();

    const unsubMessages = chat["~registerMessagesCallback"](sync, throttleMs);
    const unsubStatus = chat["~registerStatusCallback"](sync);
    const unsubError = chat["~registerErrorCallback"](sync);

    return () => {
      active = false;
      unsubMessages();
      unsubStatus();
      unsubError();
    };
  }, [chat, throttleMs]);

  const chatRef = useRef(chat);
  chatRef.current = chat;

  const setMessages = useCallback(
    (messagesParam: UI_MESSAGE[] | ((messages: UI_MESSAGE[]) => UI_MESSAGE[])) => {
      const next =
        typeof messagesParam === "function"
          ? messagesParam(chatRef.current.messages)
          : messagesParam;
      chatRef.current.messages = next;
    },
    [],
  );

  return {
    id: chat.id,
    messages: current.messages,
    setMessages,
    sendMessage: chat.sendMessage,
    regenerate: chat.regenerate,
    clearError: chat.clearError,
    stop: chat.stop,
    error: current.error,
    resumeStream: chat.resumeStream,
    status: current.status,
  };
}
