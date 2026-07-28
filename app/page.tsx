"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { useEffect, useRef, useState } from "react";
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
import { busyLabel, formatDuration } from "@/lib/format";

export default function Home() {
  const { messages, sendMessage, status, error, stop, setMessages } = useChat({
    transport: new DefaultChatTransport({ api: "/api/chat" }),
  });

  const [input, setInput] = useState("");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const wasBusyRef = useRef(false);

  const isBusy = status === "submitted" || status === "streaming";
  const hasMessages = messages.length > 0;

  const { settings, updateSettings, requestBody } = useChatSettings();

  const {
    conversations,
    activeId,
    selectConversation,
    newConversation,
    deleteConversation,
  } = useConversations({ messages, setMessages, isBusy, stop });

  const { scrollRef, atBottom, handleScroll, scrollToBottom } = useScrollAnchor(
    messages,
    isBusy,
  );

  const heartbeat = useHeartbeat(isBusy, messages);

  const { handleEditUser, handleRegenerate, handleRetry } = useChatActions({
    messages,
    setMessages,
    sendMessage,
    isBusy,
    requestBody,
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

            <div className="relative border-t border-border bg-background px-4 py-3">
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
                  onStop={stop}
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
