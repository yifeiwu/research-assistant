"use client";

import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { ArrowDown, RotateCw } from "lucide-react";
import { Message } from "@/components/Message";
import { ResearchStep } from "@/components/ResearchStep";
import { Header } from "@/components/Header";
import { Composer } from "@/components/Composer";
import { EmptyState } from "@/components/EmptyState";
import { ConversationSidebar } from "@/components/ConversationSidebar";
import { UnansweredNotice } from "@/components/UnansweredNotice";
import { useConversations } from "@/lib/hooks/useConversations";
import { useChatSettings } from "@/lib/hooks/useChatSettings";
import { useScrollAnchor } from "@/lib/hooks/useScrollAnchor";
import { useHeartbeat } from "@/lib/hooks/useHeartbeat";
import { busyLabel, formatDuration } from "@/lib/format";
import { endsUnanswered } from "@/lib/messages";
import { describeChatError } from "@/lib/chat-error";

const DESKTOP_MEDIA_QUERY = "(min-width: 768px)";

function subscribeDesktop(listener: () => void): () => void {
  const mql = window.matchMedia(DESKTOP_MEDIA_QUERY);
  mql.addEventListener("change", listener);
  return () => mql.removeEventListener("change", listener);
}

function getDesktopSnapshot(): boolean {
  return window.matchMedia(DESKTOP_MEDIA_QUERY).matches;
}

function getDesktopServerSnapshot(): boolean {
  return false;
}

export default function Home() {
  const isDesktop = useSyncExternalStore(
    subscribeDesktop,
    getDesktopSnapshot,
    getDesktopServerSnapshot,
  );
  const [sidebarOverride, setSidebarOverride] = useState<boolean | null>(null);
  const sidebarOpen = sidebarOverride ?? isDesktop;

  const [input, setInput] = useState("");
  const [announcement, setAnnouncement] = useState("");
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const wasPendingRef = useRef(false);

  const { settings, updateSettings } = useChatSettings();

  const {
    conversations,
    activeId,
    messages,
    liveProgress,
    pending,
    pendingSince,
    unansweredReason,
    error,
    isSeeded,
    selectConversation,
    newConversation,
    deleteConversation,
    sendMessage,
    editUserMessage,
    regenerateAssistantMessage,
    retryLastTurn,
    stopGeneration,
  } = useConversations({
    onTurnFinished: (answered) => {
      setAnnouncement(
        answered ? "Answer ready." : "The response ended without an answer.",
      );
    },
  });

  const heartbeat = useHeartbeat(pending, pendingSince);
  const { scrollRef, atBottom, handleScroll, scrollToBottom } = useScrollAnchor(
    messages,
    pending,
    liveProgress?.steps.length ?? 0,
    activeId,
  );

  useEffect(() => {
    if (wasPendingRef.current && !pending && messages.length > 0) {
      inputRef.current?.focus();
    }
    wasPendingRef.current = pending;
  }, [pending, messages.length]);

  const hasMessages = messages.length > 0 || pending;
  const errorInfo = error ? describeChatError(error) : null;
  const showError = !pending && errorInfo !== null;
  const showUnanswered =
    isSeeded && !pending && !showError && endsUnanswered(messages);

  function submit(text: string) {
    const trimmed = text.trim();
    if (!trimmed || pending) return;
    setAnnouncement("");
    sendMessage(trimmed, settings.effort);
    setInput("");
    scrollToBottom();
  }

  return (
    <div className="flex h-dvh bg-background">
      <ConversationSidebar
        conversations={conversations}
        activeId={activeId}
        open={sidebarOpen}
        onSelect={(id) => {
          selectConversation(id);
          if (!isDesktop) setSidebarOverride(false);
        }}
        onNewChat={() => {
          newConversation();
          setInput("");
          if (!isDesktop) setSidebarOverride(false);
        }}
        onDelete={deleteConversation}
        onClose={() => setSidebarOverride(false)}
      />

      <div className="flex min-w-0 flex-1 flex-col">
        <Header
          onNewChat={() => {
            newConversation();
            setInput("");
          }}
          onToggleSidebar={() =>
            setSidebarOverride((prev) => !(prev ?? isDesktop))
          }
        />

        {!hasMessages ? (
          <EmptyState
            input={input}
            setInput={setInput}
            onSubmit={() => submit(input)}
            onExample={submit}
            disabled={pending}
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
              <div className="mx-auto flex max-w-3xl flex-col gap-5 px-4 py-6">
                {messages.map((message) => (
                  <Message
                    key={message.id}
                    message={message}
                    onEdit={(id, next) => {
                      setAnnouncement("");
                      editUserMessage(id, next, settings.effort);
                      scrollToBottom();
                    }}
                    onRegenerate={(id) => {
                      setAnnouncement("");
                      regenerateAssistantMessage(id, settings.effort);
                      scrollToBottom();
                    }}
                  />
                ))}

                {pending && liveProgress && liveProgress.steps.length > 0 && (
                  <div className="w-full">
                    {liveProgress.steps.map((step) => (
                      <ResearchStep key={step.round} data={step} />
                    ))}
                  </div>
                )}

                <div
                  role="status"
                  aria-live="polite"
                  className={
                    pending
                      ? "flex items-center gap-2 text-sm text-muted"
                      : "sr-only"
                  }
                >
                  {pending ? (
                    <>
                      <span className="loading-dot text-accent" aria-hidden>
                        ●
                      </span>
                      <span>
                        {busyLabel(
                          liveProgress?.steps ?? [],
                          liveProgress?.wait,
                          heartbeat.now,
                        )}
                      </span>
                      <span
                        className="text-xs text-muted/70 tabular-nums"
                        aria-hidden
                      >
                        {formatDuration(heartbeat.elapsed)}
                      </span>
                    </>
                  ) : (
                    announcement
                  )}
                </div>

                {showUnanswered && (
                  <UnansweredNotice
                    reason={unansweredReason}
                    onRetry={() => {
                      setAnnouncement("");
                      retryLastTurn(settings.effort);
                      scrollToBottom();
                    }}
                  />
                )}

                {showError && errorInfo && (
                  <div
                    role="alert"
                    className="rounded-xl border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-300"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="font-medium">{errorInfo.title}</div>
                      <button
                        type="button"
                        onClick={() => {
                          setAnnouncement("");
                          retryLastTurn(settings.effort);
                          scrollToBottom();
                        }}
                        disabled={pending}
                        className="flex shrink-0 items-center gap-1.5 rounded-lg border border-red-500/40 bg-red-500/10 px-2.5 py-1 text-xs font-medium text-red-200 transition hover:bg-red-500/20 disabled:cursor-not-allowed disabled:opacity-50"
                        aria-label="Retry sending the message"
                      >
                        <RotateCw className="h-3.5 w-3.5" aria-hidden /> Retry
                      </button>
                    </div>
                    <div className="mt-1 break-words text-red-300/90">
                      {errorInfo.detail}
                    </div>
                    <div className="mt-2 text-xs text-red-300/70">
                      {errorInfo.hint}
                    </div>
                    {errorInfo.technical &&
                      errorInfo.technical !== errorInfo.detail && (
                        <details className="mt-2 text-xs text-red-300/60">
                          <summary className="cursor-pointer select-none">
                            Technical detail
                          </summary>
                          <div className="mt-1 break-words whitespace-pre-wrap">
                            {errorInfo.technical}
                          </div>
                        </details>
                      )}
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
                  onStop={() => {
                    stopGeneration();
                    setAnnouncement("Stopped.");
                  }}
                  disabled={false}
                  busy={pending}
                  settings={settings}
                  onSettingsChange={updateSettings}
                />
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
