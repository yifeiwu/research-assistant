"use client";

import { useCallback, useEffect, useRef } from "react";
import type { UIMessage } from "ai";
import type { ChatSession } from "@/lib/chat-session";
import {
  reconnectEvent,
  reconnectWhen,
  type ThreadTurn,
  type TurnEvent,
} from "@/lib/turn-machine";

/** The pause before reconnecting after a stream that ended early. */
const UNFINISHED_RECONNECT_DELAY_MS = 500;
/** How often a turn that is waiting for the user's return is tried anyway. */
const IDLE_RECONNECT_INTERVAL_MS = 15_000;

/**
 * Reconnects the open thread to its turn's stream (`GET /api/chat/:id/stream`)
 * whenever the turn is pending and the page is not connected to it:
 *
 *   1. The page was reloaded, or a thread was opened, with a turn pending.
 *   2. The connection dropped, or the browser cut it while the tab was in
 *      the background.
 *   3. The server ended the stream before the turn was over, because the
 *      request behind it could not carry the turn further. The turn then
 *      waits for the next request, so reconnecting is what continues it.
 *
 * When to reconnect is the turn machine's decision (`reconnectWhen`); this
 * hook carries it out and reports back what came of it.
 *
 * A reconnect replays the stream from its start, so an assistant message the
 * chat already has for the turn is taken out first, and rebuilt by the
 * replay. `onHold` is given that message to keep on screen meanwhile.
 */
export function useReconnect({
  session,
  chatId,
  turn,
  isSeeded,
  applyTurn,
  onHold,
}: {
  session: ChatSession;
  chatId: string;
  /** The open thread's turn. */
  turn: ThreadTurn | undefined;
  /** The chat holds the thread's saved messages. Nothing happens before that. */
  isSeeded: boolean;
  /** Apply a turn event; `messages` are the thread's final ones, if it ends the turn. */
  applyTurn: (event: TurnEvent, messages?: UIMessage[]) => void;
  /** The message to show in place of the one being replayed; null when done. */
  onHold: (chatId: string, message: UIMessage | null) => void;
}): void {
  const when = isSeeded ? reconnectWhen(turn) : null;
  // The session a reconnect is running for, so that one is not started twice.
  const running = useRef<ChatSession | null>(null);

  const reconnect = useCallback(async () => {
    if (document.visibilityState !== "visible") return;
    if (running.current === session) return;
    const { chat } = session;
    if (chat.status === "streaming" || chat.status === "submitted") return;

    const snapshot = chat.messages;
    const last = snapshot[snapshot.length - 1];
    const replaced = last?.role === "assistant" ? last : null;

    running.current = session;
    if (replaced) {
      onHold(chatId, replaced);
      session.setMessages(snapshot.slice(0, -1));
    }
    applyTurn({ type: "RESUME_START", chatId });
    try {
      await chat.resumeStream();
    } finally {
      if (running.current === session) running.current = null;
      // The rest of this function runs in the same tick, so whichever
      // message stands in the chat at its end is what is shown next.
      if (replaced) onHold(chatId, null);
    }

    const outcome = session.consumeReconnectOutcome();
    // The replay never got as far as rebuilding the message that was taken
    // out for it (nothing to replay, no connection, or given up): put it back.
    const rebuilt = chat.messages[chat.messages.length - 1]?.role === "assistant";
    if (replaced && !rebuilt) session.setMessages(snapshot);
    // Giving up a request leaves the SDK in an error state that means nothing.
    if (outcome === "aborted" && chat.error?.name === "AbortError") chat.clearError();

    const event = reconnectEvent(chatId, outcome);
    if (event) applyTurn(event, event.type === "RESUME_EMPTY" ? snapshot : undefined);
  }, [session, chatId, applyTurn, onHold]);

  // Straight away.
  useEffect(() => {
    if (when === "now") void reconnect();
  }, [when, reconnect]);

  // After a pause.
  useEffect(() => {
    if (when !== "soon") return;
    const timer = window.setTimeout(() => void reconnect(), UNFINISHED_RECONNECT_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [when, reconnect]);

  // Whenever the user comes back to the page, or the page comes back online,
  // for as long as the turn is detached (whatever it was waiting for). And,
  // for a page that is simply left open, every so often: it shows the turn
  // as reconnecting, so it has to keep trying.
  useEffect(() => {
    if (when === null) return;
    const onReturn = () => void reconnect();
    document.addEventListener("visibilitychange", onReturn);
    window.addEventListener("focus", onReturn);
    window.addEventListener("online", onReturn);
    const timer =
      when === "on-return"
        ? window.setInterval(onReturn, IDLE_RECONNECT_INTERVAL_MS)
        : undefined;
    return () => {
      document.removeEventListener("visibilitychange", onReturn);
      window.removeEventListener("focus", onReturn);
      window.removeEventListener("online", onReturn);
      window.clearInterval(timer);
    };
  }, [when, reconnect]);
}
