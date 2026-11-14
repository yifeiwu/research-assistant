"use client";

import { Chat, useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type UIMessage } from "ai";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, RotateCw } from "lucide-react";
import { Message } from "@/components/Message";
import { Header } from "@/components/Header";
import { Composer } from "@/components/Composer";
import { EmptyState } from "@/components/EmptyState";
import { ConversationSidebar } from "@/components/ConversationSidebar";
import { SettingsPanel } from "@/components/SettingsPanel";
import { useConversations } from "@/lib/hooks/useConversations";
import { useChatSettings } from "@/lib/hooks/useChatSettings";
import { useScrollAnchor } from "@/lib/hooks/useScrollAnchor";
import { useHeartbeat } from "@/lib/hooks/useHeartbeat";
import { useChatActions } from "@/lib/hooks/useChatActions";
import {
  useResumeOnVisible,
  type ReconnectOutcome,
} from "@/lib/hooks/useResumeOnVisible";
import { useTurnMachine } from "@/lib/hooks/turnMachine";
import { busyLabel, formatDuration } from "@/lib/format";
import { findLastUserMessageId } from "@/lib/messages";
import { createConversationId } from "@/lib/conversations";

function isNetworkDisconnectError(err: unknown): boolean {
  return (
    err instanceof TypeError &&
    /fetch|network|load failed/i.test(err.message)
  );
}

export default function Home() {
  const [chatId, setChatId] = useState(createConversationId);
  const turnMachine = useTurnMachine(chatId);
  const turnDispatch = turnMachine.dispatch;
  const isStopped = useCallback(
    (id: string) => turnMachine.stateRef.current.stoppedChatId === id,
    [turnMachine.stateRef],
  );
  const settleRef = useRef<(id: string, finalMessages?: UIMessage[]) => void>(
    () => {},
  );

  // Create an isolated `Chat` + abortable transport per `chatId` so:
  //   1. `onFinish` / `onError` are permanently bound to `instanceId` and can
  //      never clobber another thread's saved messages after a sidebar switch.
  //   2. `GET /api/chat/:id/stream` (used by `resumeStream()`) is wired to an
  //      `AbortController` so switching threads or clicking Stop aborts live
  //      reconnect streams immediately.
  //   3. HTTP `204` vs `200` reconnect status is recorded directly rather than
  //      inferred from React-lagged refs.
  const chatSession = useMemo(() => {
    const instanceId = chatId;
    let reconnectController: AbortController | null = null;
    let lastReconnectOutcome: ReconnectOutcome = null;
    let lastErrorWasNetwork = false;
    let lastRequestWasHttpRejection = false;

    const abortReconnect = () => {
      if (reconnectController) {
        reconnectController.abort();
        reconnectController = null;
      }
    };

    const consumeReconnectOutcome = (): ReconnectOutcome => {
      const outcome = lastReconnectOutcome;
      lastReconnectOutcome = null;
      return outcome;
    };

    const transport = new DefaultChatTransport({
      api: "/api/chat",
      fetch: async (input, init) => {
        const method = (init?.method ?? "GET").toUpperCase();
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.href
              : input.url;
        const isReconnect = method === "GET" && url.includes("/stream");

        if (isReconnect) {
          abortReconnect();
          const ctrl = new AbortController();
          reconnectController = ctrl;
          lastReconnectOutcome = null;

          try {
            const response = await globalThis.fetch(input, {
              ...init,
              signal: ctrl.signal,
            });
            if (response.status === 204) {
              lastReconnectOutcome = "empty";
            } else if (response.ok) {
              lastReconnectOutcome = "replayed";
            } else {
              lastReconnectOutcome = "error";
            }
            return response;
          } catch (err) {
            if (ctrl.signal.aborted) {
              lastReconnectOutcome = "aborted";
            } else if (isNetworkDisconnectError(err)) {
              lastReconnectOutcome = "network-error";
            } else {
              lastReconnectOutcome = "error";
            }
            throw err;
          } finally {
            if (reconnectController === ctrl && ctrl.signal.aborted) {
              reconnectController = null;
            }
          }
        }

        lastErrorWasNetwork = false;
        lastRequestWasHttpRejection = false;
        const response = await globalThis.fetch(input, init);
        if (!response.ok) {
          lastRequestWasHttpRejection = true;
        }
        return response;
      },
    });

    const chat = new Chat({
      id: instanceId,
      transport,
      onFinish: ({
        messages: finishedMessages,
        isAbort,
        isDisconnect,
        isError,
        finishReason,
      }) => {
        const wasNetworkDrop = isDisconnect || lastErrorWasNetwork;
        const wasHttpRejection = lastRequestWasHttpRejection;
        lastErrorWasNetwork = false;
        lastRequestWasHttpRejection = false;

        if (turnMachine.stateRef.current.stoppedChatId === instanceId) {
          turnDispatch({ type: "SETTLE", chatId: instanceId });
          settleRef.current(instanceId, finishedMessages);
          return;
        }
        if (isAbort || wasNetworkDrop) {
          // Detached on thread switch or dropped by network: keep `pending: true`
          // so the thread can resume or be collected from Upstash Redis.
          turnDispatch({ type: "FINISH_DETACHED", chatId: instanceId });
          return;
        }
        if (isError) {
          // Server HTTP 4xx/5xx rejections have no active Redis stream even if
          // the tab was hidden when the error arrived.
          if (wasHttpRejection || document.visibilityState === "visible") {
            settleRef.current(instanceId);
          }
          return;
        }
        // If the tab is hidden and no `finish` chunk arrived (`finishReason == null`),
        // the browser silently closed the socket — keep `pending: true` to resume.
        if (document.visibilityState !== "visible" && finishReason == null) {
          return;
        }
        turnDispatch({ type: "FINISH_OK", chatId: instanceId });
        settleRef.current(instanceId, finishedMessages);
      },
      onError: (err) => {
        const networkDrop = isNetworkDisconnectError(err);
        lastErrorWasNetwork = networkDrop;
        turnDispatch(
          networkDrop
            ? { type: "NETWORK_ERROR" }
            : { type: "NON_NETWORK_ERROR" },
        );
        if (
          !networkDrop &&
          (lastRequestWasHttpRejection ||
            document.visibilityState === "visible")
        ) {
          settleRef.current(instanceId);
        }
      },
    });

    return { chat, abortReconnect, consumeReconnectOutcome };
  }, [chatId]);

  // Ensure any in-flight local stream or reconnect poll on a previous `Chat`
  // instance is torn down cleanly on thread switch or unmount.
  useEffect(() => {
    return () => {
      chatSession.abortReconnect();
      void chatSession.chat.stop();
    };
  }, [chatSession]);

  const {
    messages,
    sendMessage,
    status,
    error,
    stop,
    setMessages,
    resumeStream,
  } = useChat({
    chat: chatSession.chat,
  });

  const [input, setInput] = useState("");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const wasBusyRef = useRef(false);

  const isBusy = status === "submitted" || status === "streaming";
  const hasMessages = messages.length > 0;

  useEffect(() => {
    if (status === "submitted" || status === "streaming") {
      turnDispatch({ type: "STATUS", status, chatId });
    }
  }, [status, chatId, turnDispatch]);

  useEffect(() => {
    turnDispatch({ type: "THREAD_SWITCH", chatId });
  }, [chatId, turnDispatch]);

  const { settings, updateSettings, requestBody } = useChatSettings();

  const stopServer = useCallback((id: string, turnId?: string) => {
    void fetch(`/api/chat/${id}/stop`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(turnId ? { turnId } : {}),
    });
  }, []);

  const detachStream = useCallback(() => {
    turnDispatch({ type: "DETACH", chatId });
    chatSession.abortReconnect();
    void stop();
  }, [chatId, chatSession, stop, turnDispatch]);

  const {
    conversations,
    activeId,
    activePending,
    isSeeded,
    selectConversation,
    newConversation,
    deleteConversation,
    settleConversation,
  } = useConversations({
    chatId,
    setChatId,
    messages,
    setMessages,
    isBusy,
    isStopped,
    detach: detachStream,
    stopServer,
  });

  settleRef.current = (id, finalMessages) => {
    settleConversation(id, finalMessages);
    turnDispatch({ type: "SETTLE", chatId: id });
  };

  const stopGeneration = useCallback(() => {
    const currentMessages = chatSession.chat.messages;
    const turnId = findLastUserMessageId(currentMessages);
    turnDispatch({ type: "STOP", chatId });
    stopServer(chatId, turnId);
    chatSession.abortReconnect();
    void stop();
    settleConversation(chatId, currentMessages);
  }, [chatId, chatSession, stop, stopServer, settleConversation, turnDispatch]);

  useResumeOnVisible({
    chatId,
    status,
    messages,
    setMessages,
    resumeStream,
    consumeReconnectOutcome: chatSession.consumeReconnectOutcome,
    isStopped,
    isSeeded,
    activePending,
    onNothingToResume: (id, restored) => {
      turnDispatch({ type: "RESUME_EMPTY", chatId: id });
      settleConversation(id, restored);
    },
    onResumeStart: (id) => turnDispatch({ type: "RESUME_START", chatId: id }),
  });

  const { scrollRef, atBottom, handleScroll, scrollToBottom } = useScrollAnchor(
    messages,
    isBusy,
  );

  const heartbeat = useHeartbeat(isBusy, messages);

  const clearStoppedForActiveChat = useCallback(() => {
    turnDispatch({ type: "SEND", chatId });
  }, [chatId, turnDispatch]);

  const { handleEditUser, handleRegenerate, handleRetry } = useChatActions({
    messages,
    setMessages,
    sendMessage,
    isBusy,
    requestBody,
    onBeforeSend: clearStoppedForActiveChat,
  });

  // Show the history sidebar by default on wider screens; keep it hidden on
  // mobile so it doesn't cover the conversation on load.
  useEffect(() => {
    if (window.matchMedia("(min-width: 768px)").matches) setSidebarOpen(true);
  }, []);

  // Return focus to the input once a response finishes streaming.
  useEffect(() => {
    if (wasBusyRef.current && !isBusy && hasMessages) {
      inputRef.current?.focus();
    }
    wasBusyRef.current = isBusy;
  }, [isBusy, hasMessages]);

  function submit(text: string) {
    const trimmed = text.trim();
    if (!trimmed || isBusy) return;
    turnDispatch({ type: "SEND", chatId });
    void sendMessage({ text: trimmed }, { body: requestBody() });
    setInput("");
  }

  return (
    <div className="flex h-dvh bg-background">
      <ConversationSidebar
        conversations={conversations}
        activeId={activeId}
        open={sidebarOpen}
        settings={settings}
        onSelect={(id) => {
          selectConversation(id);
          if (window.matchMedia("(max-width: 767px)").matches) {
            setSidebarOpen(false);
          }
        }}
        onNewChat={() => {
          newConversation();
          setInput("");
        }}
        onDelete={deleteConversation}
        onClose={() => setSidebarOpen(false)}
        onOpenSettings={() => setSettingsOpen(true)}
      />

      <div className="flex min-w-0 flex-1 flex-col">
        <Header
          onNewChat={() => {
            newConversation();
            setInput("");
          }}
          onToggleSidebar={() => setSidebarOpen((o) => !o)}
        />

        {!hasMessages ? (
          <EmptyState
            input={input}
            setInput={setInput}
            onSubmit={() => submit(input)}
            onExample={submit}
            disabled={isBusy}
            settings={settings}
            onSettingsChange={updateSettings}
          />
        ) : (
          <>
            <main
              ref={scrollRef}
              onScroll={handleScroll}
              className="relative flex-1 overflow-y-auto"
            >
              <div
                className="mx-auto flex max-w-3xl flex-col gap-5 px-4 py-6"
                aria-live="polite"
                aria-busy={isBusy}
              >
                {messages.map((message, i) => (
                  <Message
                    key={message.id}
                    message={message}
                    streaming={
                      status === "streaming" &&
                      i === messages.length - 1 &&
                      message.role === "assistant"
                    }
                    onEdit={handleEditUser}
                    onRegenerate={handleRegenerate}
                  />
                ))}

                {isBusy && (
                  <div
                    role="status"
                    aria-live="polite"
                    className="flex items-center gap-2 text-sm text-muted"
                  >
                    <span className="loading-dot text-accent">●</span>
                    <span>{busyLabel(status, heartbeat.idle)}</span>
                    <span className="text-xs text-muted/70 tabular-nums">
                      {formatDuration(heartbeat.elapsed)}
                    </span>
                  </div>
                )}

                {error && (
                  <div className="rounded-xl border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-300">
                    <div className="flex items-start justify-between gap-3">
                      <div className="font-medium">Something went wrong</div>
                      <button
                        type="button"
                        onClick={handleRetry}
                        disabled={isBusy}
                        className="flex shrink-0 items-center gap-1.5 rounded-lg border border-red-500/40 bg-red-500/10 px-2.5 py-1 text-xs font-medium text-red-200 transition hover:bg-red-500/20 disabled:cursor-not-allowed disabled:opacity-50"
                        aria-label="Retry sending the message"
                      >
                        <RotateCw className="h-3.5 w-3.5" aria-hidden /> Retry
                      </button>
                    </div>
                    <div className="mt-1 break-words text-red-300/90">
                      {error.message}
                    </div>
                    <div className="mt-2 text-xs text-red-300/70">
                      This can happen intermittently with some models. Try
                      sending the message again, or switch models in Settings. If
                      it persists, check that your API keys are set.
                    </div>
                  </div>
                )}
              </div>
            </main>

            <div className="relative border-t border-border bg-background px-4 pt-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))]">
              {!atBottom && (
                <button
                  type="button"
                  onClick={scrollToBottom}
                  className="absolute -top-12 left-1/2 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-border bg-surface px-3 py-1.5 text-xs text-muted shadow-lg transition hover:border-accent hover:text-foreground"
                  aria-label="Jump to latest message"
                >
                  <ArrowDown className="h-3.5 w-3.5" aria-hidden /> Jump to latest
                </button>
              )}
              <div className="mx-auto max-w-3xl">
                <Composer
                  inputRef={inputRef}
                  input={input}
                  setInput={setInput}
                  onSubmit={() => submit(input)}
                  onStop={stopGeneration}
                  disabled={false}
                  busy={isBusy}
                  settings={settings}
                  onSettingsChange={updateSettings}
                      />
              </div>
            </div>
          </>
        )}
      </div>

      {settingsOpen && (
        <SettingsPanel
          settings={settings}
          onChange={updateSettings}
          onClose={() => setSettingsOpen(false)}
        />
      )}
    </div>
  );
}
