"use client";

import type { UIMessage } from "ai";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { ArrowDown, RotateCw } from "lucide-react";
import { Message } from "@/components/Message";
import { Header } from "@/components/Header";
import { Composer } from "@/components/Composer";
import { EmptyState } from "@/components/EmptyState";
import { ConversationSidebar } from "@/components/ConversationSidebar";
import { UnansweredNotice } from "@/components/UnansweredNotice";
import { useChatState } from "@/lib/hooks/useChatState";
import { useConversations } from "@/lib/hooks/useConversations";
import { useChatSettings } from "@/lib/hooks/useChatSettings";
import { useScrollAnchor } from "@/lib/hooks/useScrollAnchor";
import { useHeartbeat } from "@/lib/hooks/useHeartbeat";
import { useChatActions } from "@/lib/hooks/useChatActions";
import { useReconnect } from "@/lib/hooks/useReconnect";
import { useTurnMachine } from "@/lib/hooks/useTurnMachine";
import { createChatSession } from "@/lib/chat-session";
import { busyLabel, formatDuration } from "@/lib/format";
import { endsUnanswered, findLastUserMessageId } from "@/lib/messages";
import {
  CHAT_STREAM_THROTTLE_MS,
  createConversationId,
} from "@/lib/conversations";
import { describeChatError } from "@/lib/chat-error";
import { isPending, streamEndEvent, type TurnEvent } from "@/lib/turn-machine";
import { activeTurnStatus } from "@/lib/turn-status";
import { withHeldMessage } from "@/lib/turn-view";

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
  const [activeThread, setActiveThread] = useState<{
    id: string;
    initialMessages?: UIMessage[];
  }>(() => ({ id: createConversationId() }));
  const chatId = activeThread.id;

  // The state of every thread's latest turn (lib/turn-machine.ts).
  const {
    state: turnState,
    dispatch: dispatchTurn,
    getState: getTurnState,
  } = useTurnMachine(chatId);
  const activeTurn = turnState.threads[chatId];
  const turnActive = isPending(activeTurn?.phase);

  const openThread = useCallback(
    (id: string, initialMessages?: UIMessage[]) => {
      dispatchTurn({ type: "ACTIVATE", chatId: id });
      setActiveThread({ id, initialMessages });
    },
    [dispatchTurn],
  );

  const session = useMemo(
    () =>
      createChatSession(activeThread.id, {
        initialMessages: activeThread.initialMessages,
      }),
    [activeThread],
  );

  useEffect(() => {
    return () => {
      session.abortReconnect();
      void session.chat.stop();
    };
  }, [session]);

  const { messages, sendMessage, status, error, stop, setMessages } =
    useChatState(session.chat, CHAT_STREAM_THROTTLE_MS);

  const isDesktop = useSyncExternalStore(
    subscribeDesktop,
    getDesktopSnapshot,
    getDesktopServerSnapshot,
  );
  const [sidebarOverride, setSidebarOverride] = useState<boolean | null>(null);
  const sidebarOpen = sidebarOverride ?? isDesktop;

  const [input, setInput] = useState("");
  const [held, setHeld] = useState<{ chatId: string; message: UIMessage } | null>(
    null,
  );
  const [announcement, setAnnouncement] = useState("");
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const wasActiveRef = useRef(false);

  const isBusy = status === "submitted" || status === "streaming";
  const errorInfo = error ? describeChatError(error) : null;

  useEffect(() => {
    if (status === "streaming") dispatchTurn({ type: "STREAMING", chatId });
  }, [status, chatId, dispatchTurn]);

  const { settings, updateSettings, requestBody } = useChatSettings();

  const stopServer = useCallback((id: string, turnId?: string) => {
    void fetch(`/api/chat/${id}/stop`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(turnId ? { turnId } : {}),
      keepalive: true,
    });
  }, []);

  const getTurn = useCallback(
    (id: string) => getTurnState().threads[id],
    [getTurnState],
  );

  const detachStream = useCallback(() => {
    session.abortReconnect();
    void stop();
  }, [session, stop]);

  const {
    conversations,
    activeId,
    isSeeded,
    selectConversation,
    newConversation,
    deleteConversation,
    deleted,
    undoDelete,
    settleConversation,
  } = useConversations({
    chatId,
    setChatId: openThread,
    messages,
    setMessages,
    isBusy,
    activeTurn,
    getTurn,
    dispatchTurn,
    detach: detachStream,
    stopServer,
  });

  const listedConversations = useMemo(
    () =>
      conversations.map((conv) => {
        const pending = isPending(turnState.threads[conv.id]?.phase);
        return Boolean(conv.pending) === pending ? conv : { ...conv, pending };
      }),
    [conversations, turnState.threads],
  );

  const applyTurn = useCallback(
    (event: TurnEvent, finalMessages?: UIMessage[]) => {
      const id = "chatId" in event ? event.chatId : null;
      const wasPending =
        id !== null && isPending(getTurnState().threads[id]?.phase);
      const next = dispatchTurn(event);
      if (id === null || isPending(next.threads[id]?.phase)) return;
      if (wasPending || finalMessages) settleConversation(id, finalMessages);
    },
    [dispatchTurn, getTurnState, settleConversation],
  );

  const heldMessage = held?.chatId === chatId ? held.message : null;
  const shownMessages = useMemo(
    () => withHeldMessage(messages, heldMessage),
    [messages, heldMessage],
  );
  const holding = shownMessages !== messages;
  const hasMessages = shownMessages.length > 0;

  useEffect(() => {
    return session.onStreamEnd((end) => {
      const event = streamEndEvent(chatId, end);
      if (getTurnState().threads[chatId]?.phase === "stopped") {
        const final = withHeldMessage(end.messages, heldMessage);
        if (final !== end.messages) setMessages(final);
        applyTurn(event, final);
        return;
      }
      applyTurn(event, event.type === "FINISHED" ? end.messages : undefined);
      if (event.type === "FINISHED") {
        setAnnouncement(
          endsUnanswered(end.messages)
            ? "The response ended without an answer."
            : "Answer ready.",
        );
      }
    });
  }, [session, chatId, applyTurn, getTurnState, heldMessage, setMessages]);

  const stopGeneration = useCallback(() => {
    const finalMessages = withHeldMessage(session.chat.messages, heldMessage);
    stopServer(chatId, findLastUserMessageId(finalMessages));
    session.abortReconnect();
    void stop();
    applyTurn({ type: "STOP", chatId }, finalMessages);
    setAnnouncement("Stopped.");
  }, [chatId, session, heldMessage, stop, stopServer, applyTurn]);

  const holdMessage = useCallback((id: string, message: UIMessage | null) => {
    setHeld(message ? { chatId: id, message } : null);
  }, []);

  useReconnect({
    session,
    chatId,
    turn: activeTurn,
    isSeeded,
    applyTurn,
    onHold: holdMessage,
  });

  const { scrollRef, atBottom, handleScroll, scrollToBottom } = useScrollAnchor(
    shownMessages,
    turnActive,
  );

  const heartbeat = useHeartbeat(turnActive, messages, activeTurn?.since);

  const lastMessage = shownMessages[shownMessages.length - 1];
  const lastIsAssistant = lastMessage?.role === "assistant";
  const turnPaused =
    turnActive && lastIsAssistant && activeTurnStatus(lastMessage) !== null;

  const showError = activeTurn?.phase === "failed" && errorInfo !== null;
  const showUnanswered =
    isSeeded && !turnActive && !showError && endsUnanswered(shownMessages);

  const beginTurn = useCallback(() => {
    dispatchTurn({ type: "SEND", chatId, at: Date.now() });
    setAnnouncement("");
  }, [chatId, dispatchTurn]);

  const { handleEditUser, handleRegenerate, handleRetry } = useChatActions({
    messages,
    setMessages,
    sendMessage,
    isBusy: isBusy || turnActive,
    requestBody,
    onBeforeSend: beginTurn,
  });

  // Return focus to the input once a turn is over.
  useEffect(() => {
    if (wasActiveRef.current && !turnActive && hasMessages) {
      inputRef.current?.focus();
    }
    wasActiveRef.current = turnActive;
  }, [turnActive, hasMessages]);

  function submit(text: string) {
    const trimmed = text.trim();
    if (!trimmed || isBusy || turnActive) return;
    beginTurn();
    void sendMessage({ text: trimmed }, { body: requestBody() });
    setInput("");
  }

  return (
    <div className="flex h-dvh bg-background">
      <ConversationSidebar
        conversations={listedConversations}
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
        deleted={deleted}
        onUndoDelete={undoDelete}
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
              <div className="mx-auto flex max-w-3xl flex-col gap-5 px-4 py-6">
                {shownMessages.map((message, i) => (
                  <Message
                    key={message.id}
                    message={message}
                    streaming={
                      turnActive &&
                      i === shownMessages.length - 1 &&
                      message.role === "assistant"
                    }
                    onEdit={handleEditUser}
                    onRegenerate={handleRegenerate}
                  />
                ))}

                <div
                  role="status"
                  aria-live="polite"
                  className={
                    turnActive
                      ? "flex items-center gap-2 text-sm text-muted"
                      : "sr-only"
                  }
                >
                  {turnActive ? (
                    <>
                      <span className="loading-dot text-accent" aria-hidden>
                        ●
                      </span>
                      <span>
                        {busyLabel(activeTurn?.phase, heartbeat.idle, {
                          nothingYet:
                            !lastIsAssistant || lastMessage.parts.length === 0,
                          paused: turnPaused,
                          replaying: holding,
                        })}
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
                    reason={
                      activeTurn?.phase === "stopped" ||
                      activeTurn?.phase === "expired"
                        ? activeTurn.phase
                        : undefined
                    }
                    onRetry={handleRetry}
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
                        onClick={handleRetry}
                        disabled={isBusy}
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
                  onStop={stopGeneration}
                  disabled={false}
                  busy={turnActive}
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
