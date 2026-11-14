"use client";

import { useChat } from "@ai-sdk/react";
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
import { useResumeOnVisible } from "@/lib/hooks/useResumeOnVisible";
import { busyLabel, formatDuration } from "@/lib/format";
import { createConversationId } from "@/lib/conversations";

function isNetworkDisconnectError(err: unknown): boolean {
  return (
    err instanceof TypeError &&
    /fetch|network|load failed/i.test(err.message)
  );
}

export default function Home() {
  const [chatId, setChatId] = useState(createConversationId);
  const userStoppedRef = useRef(false);
  const lastErrorWasNetworkRef = useRef(false);
  const chatIdRef = useRef(chatId);
  const activeStreamChatIdRef = useRef(chatId);
  const settleRef = useRef<(id: string, finalMessages?: UIMessage[]) => void>(
    () => {},
  );

  useEffect(() => {
    chatIdRef.current = chatId;
  }, [chatId]);

  const transport = useMemo(
    () => new DefaultChatTransport({ api: "/api/chat" }),
    [],
  );

  const {
    messages,
    sendMessage,
    status,
    error,
    stop,
    setMessages,
    resumeStream,
  } = useChat({
    id: chatId,
    transport,
    onFinish: ({
      messages: finishedMessages,
      isAbort,
      isDisconnect,
      isError,
      finishReason,
    }) => {
      const targetId = activeStreamChatIdRef.current;
      const wasNetworkDrop = isDisconnect || lastErrorWasNetworkRef.current;
      lastErrorWasNetworkRef.current = false;

      if (userStoppedRef.current) {
        settleRef.current(targetId, finishedMessages);
        return;
      }
      if (isAbort || wasNetworkDrop) {
        // Detached on thread switch or dropped by network: keep `pending: true`
        // so the thread can resume from Upstash Redis.
        return;
      }
      if (isError) {
        if (document.visibilityState === "visible") {
          settleRef.current(targetId);
        }
        return;
      }
      // If the tab is hidden and no `finish` chunk arrived (`finishReason == null`),
      // the browser silently closed the socket — keep `pending: true` to resume.
      if (document.visibilityState !== "visible" && finishReason == null) {
        return;
      }
      settleRef.current(targetId, finishedMessages);
    },
    onError: (err) => {
      const networkDrop = isNetworkDisconnectError(err);
      lastErrorWasNetworkRef.current = networkDrop;
      if (!networkDrop && document.visibilityState === "visible") {
        settleRef.current(chatIdRef.current);
      }
    },
  });

  const [input, setInput] = useState("");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const wasBusyRef = useRef(false);

  const isBusy = status === "submitted" || status === "streaming";
  const hasMessages = messages.length > 0;

  useEffect(() => {
    if (isBusy) {
      activeStreamChatIdRef.current = chatId;
    }
  }, [isBusy, chatId]);

  const { settings, updateSettings, requestBody } = useChatSettings();

  const stopServer = useCallback((id: string) => {
    void fetch(`/api/chat/${id}/stop`, { method: "POST" });
  }, []);

  const detachStream = useCallback(() => {
    userStoppedRef.current = false;
    stop();
  }, [stop]);

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
    detach: detachStream,
    stopServer,
  });

  useEffect(() => {
    settleRef.current = settleConversation;
  }, [settleConversation]);

  const stopGeneration = useCallback(() => {
    userStoppedRef.current = true;
    stopServer(chatId);
    stop();
    settleConversation(chatId, messages);
  }, [chatId, messages, stop, stopServer, settleConversation]);

  useResumeOnVisible({
    chatId,
    status,
    messages,
    setMessages,
    resumeStream,
    userStoppedRef,
    isSeeded,
    activePending,
    onNothingToResume: settleConversation,
  });

  const { scrollRef, atBottom, handleScroll, scrollToBottom } = useScrollAnchor(
    messages,
    isBusy,
  );

  const heartbeat = useHeartbeat(isBusy, messages);

  const resetUserStopped = useCallback(() => {
    userStoppedRef.current = false;
    lastErrorWasNetworkRef.current = false;
    activeStreamChatIdRef.current = chatIdRef.current;
  }, []);

  const { handleEditUser, handleRegenerate, handleRetry } = useChatActions({
    messages,
    setMessages,
    sendMessage,
    isBusy,
    requestBody,
    onBeforeSend: resetUserStopped,
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
    resetUserStopped();
    sendMessage({ text: trimmed }, { body: requestBody() });
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
          resetUserStopped();
          selectConversation(id);
          if (window.matchMedia("(max-width: 767px)").matches) {
            setSidebarOpen(false);
          }
        }}
        onNewChat={() => {
          resetUserStopped();
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
            resetUserStopped();
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
            onOpenSettings={() => setSettingsOpen(true)}
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
                  onOpenSettings={() => setSettingsOpen(true)}
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
