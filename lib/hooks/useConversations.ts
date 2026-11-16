"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  type Conversation,
  createConversationId,
  deriveTitle,
  loadActiveConversationId,
  loadConversations,
  saveActiveConversationId,
  saveConversations,
} from "@/lib/conversations";
import type { EffortLevel } from "@/lib/effort";
import { findLastUserMessageId } from "@/lib/messages";
import { fetchWithRetryAfter } from "@/lib/retry-fetch";
import type {
  ChatMessage,
  DurableTurnState,
  ResearchSource,
  ResearchStepData,
  TurnWaitState,
} from "@/lib/types/chat";

const ACTIVE_POLL_MS = 1_000;
const BG_POLL_MS = 3_000;

type LiveProgress = {
  steps: ResearchStepData[];
  sources: ResearchSource[];
  wait?: TurnWaitState;
};

export type UseConversations = {
  conversations: Conversation[];
  activeId: string;
  messages: ChatMessage[];
  liveProgress: LiveProgress | null;
  pending: boolean;
  pendingSince?: number;
  unansweredReason?: "stopped" | "expired";
  error: Error | null;
  isSeeded: boolean;
  selectConversation: (id: string) => void;
  newConversation: () => void;
  deleteConversation: (id: string) => void;
  sendMessage: (text: string, effort: EffortLevel) => void;
  editUserMessage: (messageId: string, newText: string, effort: EffortLevel) => void;
  regenerateAssistantMessage: (assistantId: string, effort: EffortLevel) => void;
  retryLastTurn: (effort: EffortLevel) => void;
  stopGeneration: () => void;
};

function stopServerTurn(chatId: string, turnId?: string): void {
  void fetch(`/api/chat/${chatId}/stop`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(turnId ? { turnId } : {}),
    keepalive: true,
  }).catch(() => {});
}

export function useConversations(opts?: {
  onTurnFinished?: (answered: boolean) => void;
}): UseConversations {
  const [activeId, setActiveId] = useState<string>(() => createConversationId());
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [liveByChat, setLiveByChat] = useState<Record<string, LiveProgress>>({});
  const [errorsByChat, setErrorsByChat] = useState<Record<string, Error>>({});
  const [isSeeded, setIsSeeded] = useState(false);

  const activeIdRef = useRef(activeId);
  useEffect(() => {
    activeIdRef.current = activeId;
  }, [activeId]);

  const conversationsRef = useRef(conversations);
  useEffect(() => {
    conversationsRef.current = conversations;
  }, [conversations]);

  const onFinishedRef = useRef(opts?.onTurnFinished);
  useEffect(() => {
    onFinishedRef.current = opts?.onTurnFinished;
  }, [opts?.onTurnFinished]);

  // Track chats whose POST /api/chat is still in flight so an early 204 poll
  // before Redis registration never falsely marks the turn as expired.
  const startingChatsRef = useRef<Set<string>>(new Set());
  const inFlightPollsRef = useRef<Map<string, AbortController>>(new Map());
  const postControllersRef = useRef<Map<string, AbortController>>(new Map());

  const persistConversations = useCallback(
    (updater: (prev: Conversation[]) => Conversation[]) => {
      setConversations((prev) => {
        const updated = updater(prev);
        if (updated === prev) return prev;
        const saved = saveConversations(updated);
        conversationsRef.current = saved;
        return saved;
      });
    },
    [],
  );

  // Hydrate persisted conversations from localStorage on mount.
  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      const list = loadConversations();
      const storedActive = loadActiveConversationId();
      conversationsRef.current = list;
      setConversations(list);

      const target = storedActive ? list.find((c) => c.id === storedActive) : undefined;
      if (target) {
        activeIdRef.current = target.id;
        setActiveId(target.id);
      } else {
        saveActiveConversationId(activeIdRef.current);
      }
      setIsSeeded(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Abort all in-flight polls on unmount.
  useEffect(() => {
    const polls = inFlightPollsRef.current;
    const posts = postControllersRef.current;
    return () => {
      for (const ctrl of polls.values()) ctrl.abort();
      for (const ctrl of posts.values()) ctrl.abort();
      polls.clear();
      posts.clear();
    };
  }, []);

  const applyTurnState = useCallback(
    (chatId: string, state: DurableTurnState | null) => {
      if (!state) {
        if (startingChatsRef.current.has(chatId)) return;
        setLiveByChat((prev) => {
          if (!(chatId in prev)) return prev;
          const next = { ...prev };
          delete next[chatId];
          return next;
        });
        persistConversations((prev) =>
          prev.map((c) =>
            c.id === chatId && c.pending
              ? {
                  ...c,
                  pending: false,
                  pendingSince: undefined,
                  unansweredReason: "expired",
                  updatedAt: Date.now(),
                }
              : c,
          ),
        );
        return;
      }

      if (state.status === "running") {
        setLiveByChat((prev) => ({
          ...prev,
          [chatId]: {
            steps: state.steps,
            sources: state.sources,
            wait: state.wait,
          },
        }));
        return;
      }

      // Terminal state: clear live progress for this thread.
      setLiveByChat((prev) => {
        if (!(chatId in prev)) return prev;
        const next = { ...prev };
        delete next[chatId];
        return next;
      });

      if (state.status === "done" && state.message) {
        const assistantMessage = state.message;
        setErrorsByChat((prev) => {
          if (!(chatId in prev)) return prev;
          const next = { ...prev };
          delete next[chatId];
          return next;
        });
        persistConversations((prev) =>
          prev.map((c) => {
            if (c.id !== chatId || !c.pending) return c;
            const base =
              c.messages[c.messages.length - 1]?.role === "assistant"
                ? c.messages.slice(0, -1)
                : c.messages;
            return {
              ...c,
              messages: [...base, assistantMessage],
              pending: false,
              pendingSince: undefined,
              unansweredReason: undefined,
              updatedAt: Date.now(),
            };
          }),
        );
        if (chatId === activeIdRef.current) {
          onFinishedRef.current?.(Boolean(assistantMessage.text.trim()));
        }
        return;
      }

      if (state.status === "stopped") {
        persistConversations((prev) =>
          prev.map((c) =>
            c.id === chatId && c.pending
              ? {
                  ...c,
                  pending: false,
                  pendingSince: undefined,
                  unansweredReason: "stopped",
                  updatedAt: Date.now(),
                }
              : c,
          ),
        );
        return;
      }

      if (state.status === "error") {
        setErrorsByChat((prev) => ({
          ...prev,
          [chatId]: new Error(state.error ?? "Something went wrong."),
        }));
        persistConversations((prev) =>
          prev.map((c) =>
            c.id === chatId && c.pending
              ? {
                  ...c,
                  pending: false,
                  pendingSince: undefined,
                  updatedAt: Date.now(),
                }
              : c,
          ),
        );
      }
    },
    [persistConversations],
  );

  const pollChat = useCallback(
    (chatId: string) => {
      if (inFlightPollsRef.current.has(chatId)) return;
      const ctrl = new AbortController();
      inFlightPollsRef.current.set(chatId, ctrl);

      void fetch(`/api/chat/${chatId}`, {
        method: "GET",
        signal: ctrl.signal,
      })
        .then(async (res) => {
          if (ctrl.signal.aborted) return;
          if (res.status === 204) {
            applyTurnState(chatId, null);
            return;
          }
          if (!res.ok) return;
          const data = (await res.json()) as DurableTurnState;
          if (!ctrl.signal.aborted) {
            applyTurnState(chatId, data);
          }
        })
        .catch(() => {
          // Transient network blip; next poll will retry automatically.
        })
        .finally(() => {
          if (inFlightPollsRef.current.get(chatId) === ctrl) {
            inFlightPollsRef.current.delete(chatId);
          }
        });
    },
    [applyTurnState],
  );

  const activeConv = useMemo(
    () => conversations.find((c) => c.id === activeId),
    [conversations, activeId],
  );
  const activePending = Boolean(activeConv?.pending);
  const hasBgPending = useMemo(
    () => conversations.some((c) => c.pending && c.id !== activeId),
    [conversations, activeId],
  );

  // Poll the open active thread every 1s while pending.
  useEffect(() => {
    if (!isSeeded || !activePending) return;
    const check = () => {
      if (document.visibilityState === "visible") pollChat(activeId);
    };
    check();
    const timer = window.setInterval(check, ACTIVE_POLL_MS);
    document.addEventListener("visibilitychange", check);
    window.addEventListener("online", check);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", check);
      window.removeEventListener("online", check);
    };
  }, [isSeeded, activePending, activeId, pollChat]);

  // Poll pending background threads every 3s so finished answers save automatically.
  useEffect(() => {
    if (!isSeeded || !hasBgPending) return;
    const checkBg = () => {
      if (document.visibilityState !== "visible") return;
      for (const conv of conversationsRef.current) {
        if (conv.pending && conv.id !== activeIdRef.current) {
          pollChat(conv.id);
        }
      }
    };
    const initial = window.setTimeout(checkBg, 500);
    const timer = window.setInterval(checkBg, BG_POLL_MS);
    document.addEventListener("visibilitychange", checkBg);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", checkBg);
    };
  }, [isSeeded, hasBgPending, pollChat]);

  const dispatchPrompt = useCallback(
    (chatId: string, promptMessages: ChatMessage[], effort: EffortLevel) => {
      const now = Date.now();
      startingChatsRef.current.add(chatId);

      setErrorsByChat((prev) => {
        if (!(chatId in prev)) return prev;
        const next = { ...prev };
        delete next[chatId];
        return next;
      });
      setLiveByChat((prev) => ({
        ...prev,
        [chatId]: { steps: [], sources: [] },
      }));

      persistConversations((prev) => {
        const existing = prev.find((c) => c.id === chatId);
        const updated: Conversation = {
          id: chatId,
          title: existing?.title ?? deriveTitle(promptMessages),
          messages: promptMessages,
          pending: true,
          pendingSince: now,
          unansweredReason: undefined,
          createdAt: existing?.createdAt ?? now,
          updatedAt: now,
        };
        return [updated, ...prev.filter((c) => c.id !== chatId)];
      });

      postControllersRef.current.get(chatId)?.abort();
      const postCtrl = new AbortController();
      postControllersRef.current.set(chatId, postCtrl);

      void fetchWithRetryAfter(
        globalThis.fetch,
        "/api/chat",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id: chatId, messages: promptMessages, effort }),
          signal: postCtrl.signal,
        },
      )
        .then(async (res) => {
          startingChatsRef.current.delete(chatId);
          if (postCtrl.signal.aborted) return;
          if (!res.ok) {
            const payload = (await res.json().catch(() => null)) as {
              error?: string;
            } | null;
            throw new Error(
              payload?.error ?? `Request failed with HTTP ${res.status}.`,
            );
          }
          const initial = (await res.json()) as DurableTurnState;
          applyTurnState(chatId, initial);
        })
        .catch((err) => {
          startingChatsRef.current.delete(chatId);
          if (postCtrl.signal.aborted) return;
          setLiveByChat((prev) => {
            const next = { ...prev };
            delete next[chatId];
            return next;
          });
          setErrorsByChat((prev) => ({
            ...prev,
            [chatId]: err instanceof Error ? err : new Error(String(err)),
          }));
          persistConversations((prev) =>
            prev.map((c) =>
              c.id === chatId
                ? { ...c, pending: false, pendingSince: undefined, updatedAt: Date.now() }
                : c,
            ),
          );
        })
        .finally(() => {
          if (postControllersRef.current.get(chatId) === postCtrl) {
            postControllersRef.current.delete(chatId);
          }
        });
    },
    [persistConversations, applyTurnState],
  );

  const sendMessage = useCallback(
    (text: string, effort: EffortLevel) => {
      const trimmed = text.trim();
      const id = activeIdRef.current;
      const current = conversationsRef.current.find((c) => c.id === id);
      if (!trimmed || current?.pending) return;

      const userMsg: ChatMessage = {
        id: createConversationId(),
        role: "user",
        text: trimmed,
      };
      dispatchPrompt(id, [...(current?.messages ?? []), userMsg], effort);
    },
    [dispatchPrompt],
  );

  const editUserMessage = useCallback(
    (messageId: string, newText: string, effort: EffortLevel) => {
      const trimmed = newText.trim();
      const id = activeIdRef.current;
      const current = conversationsRef.current.find((c) => c.id === id);
      if (!trimmed || !current || current.pending) return;
      const idx = current.messages.findIndex((m) => m.id === messageId);
      if (idx === -1) return;

      const userMsg: ChatMessage = {
        id: createConversationId(),
        role: "user",
        text: trimmed,
      };
      dispatchPrompt(id, [...current.messages.slice(0, idx), userMsg], effort);
    },
    [dispatchPrompt],
  );

  const regenerateAssistantMessage = useCallback(
    (assistantId: string, effort: EffortLevel) => {
      const id = activeIdRef.current;
      const current = conversationsRef.current.find((c) => c.id === id);
      if (!current || current.pending) return;
      const idx = current.messages.findIndex((m) => m.id === assistantId);
      if (idx === -1) return;
      for (let i = idx - 1; i >= 0; i--) {
        if (current.messages[i].role === "user") {
          dispatchPrompt(id, current.messages.slice(0, i + 1), effort);
          return;
        }
      }
    },
    [dispatchPrompt],
  );

  const retryLastTurn = useCallback(
    (effort: EffortLevel) => {
      const id = activeIdRef.current;
      const current = conversationsRef.current.find((c) => c.id === id);
      if (!current || current.pending) return;
      for (let i = current.messages.length - 1; i >= 0; i--) {
        if (current.messages[i].role === "user") {
          dispatchPrompt(id, current.messages.slice(0, i + 1), effort);
          return;
        }
      }
    },
    [dispatchPrompt],
  );

  const stopGeneration = useCallback(() => {
    const id = activeIdRef.current;
    const current = conversationsRef.current.find((c) => c.id === id);
    startingChatsRef.current.delete(id);
    postControllersRef.current.get(id)?.abort();
    inFlightPollsRef.current.get(id)?.abort();

    stopServerTurn(id, findLastUserMessageId(current?.messages ?? []));

    setLiveByChat((prev) => {
      if (!(id in prev)) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
    persistConversations((prev) =>
      prev.map((c) =>
        c.id === id && c.pending
          ? {
              ...c,
              pending: false,
              pendingSince: undefined,
              unansweredReason: "stopped",
              updatedAt: Date.now(),
            }
          : c,
      ),
    );
  }, [persistConversations]);

  const selectConversation = useCallback((id: string) => {
    if (id === activeIdRef.current) return;
    activeIdRef.current = id;
    setActiveId(id);
    saveActiveConversationId(id);
  }, []);

  const newConversation = useCallback(() => {
    const nextId = createConversationId();
    activeIdRef.current = nextId;
    setActiveId(nextId);
    saveActiveConversationId(nextId);
  }, []);

  const deleteConversation = useCallback(
    (id: string) => {
      const target = conversationsRef.current.find((c) => c.id === id);
      startingChatsRef.current.delete(id);
      postControllersRef.current.get(id)?.abort();
      inFlightPollsRef.current.get(id)?.abort();

      if (target?.pending) {
        stopServerTurn(id, findLastUserMessageId(target.messages));
      }

      setLiveByChat((prev) => {
        if (!(id in prev)) return prev;
        const next = { ...prev };
        delete next[id];
        return next;
      });
      setErrorsByChat((prev) => {
        if (!(id in prev)) return prev;
        const next = { ...prev };
        delete next[id];
        return next;
      });
      persistConversations((prev) => prev.filter((c) => c.id !== id));

      if (activeIdRef.current === id) {
        const nextId = createConversationId();
        activeIdRef.current = nextId;
        setActiveId(nextId);
        saveActiveConversationId(nextId);
      }
    },
    [persistConversations],
  );

  return {
    conversations,
    activeId,
    messages: activeConv?.messages ?? [],
    liveProgress: activePending ? (liveByChat[activeId] ?? { steps: [], sources: [] }) : null,
    pending: activePending,
    pendingSince: activeConv?.pendingSince,
    unansweredReason: activeConv?.unansweredReason,
    error: errorsByChat[activeId] ?? null,
    isSeeded,
    selectConversation,
    newConversation,
    deleteConversation,
    sendMessage,
    editUserMessage,
    regenerateAssistantMessage,
    retryLastTurn,
    stopGeneration,
  };
}
