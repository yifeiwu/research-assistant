"use client";

import { useCallback, useRef } from "react";

type TurnStatus =
  | "idle"
  | "submitted"
  | "streaming"
  | "resuming"
  | "stopping"
  | "settling"
  | "error"
  | "detached";

export type TurnState = {
  status: TurnStatus;
  chatId: string | null;
  userStopped: boolean;
  stoppedChatId: string | null;
  lastErrorWasNetwork: boolean;
};

export type TurnEvent =
  | { type: "SEND"; chatId: string }
  | { type: "STATUS"; status: "submitted" | "streaming" | "ready" | "error"; chatId?: string }
  | { type: "STOP"; chatId: string }
  | { type: "NETWORK_ERROR" }
  | { type: "NON_NETWORK_ERROR" }
  | { type: "FINISH_OK"; chatId: string }
  | { type: "FINISH_DETACHED"; chatId: string }
  | { type: "DETACH"; chatId: string }
  | { type: "THREAD_SWITCH"; chatId: string }
  | { type: "RESUME_START"; chatId: string }
  | { type: "RESUME_EMPTY"; chatId: string }
  | { type: "SETTLE"; chatId: string };

export const initialTurnState: TurnState = {
  status: "idle",
  chatId: null,
  userStopped: false,
  stoppedChatId: null,
  lastErrorWasNetwork: false,
};

export function turnReducer(state: TurnState, event: TurnEvent): TurnState {
  switch (event.type) {
    case "SEND":
      return {
        status: "submitted",
        chatId: event.chatId,
        userStopped: false,
        stoppedChatId: null,
        lastErrorWasNetwork: false,
      };
    case "STATUS": {
      if (event.status === "ready") {
        return state.status === "detached"
          ? state
          : { ...state, status: "settling" };
      }
      if (event.status === "error") return { ...state, status: "error" };
      return { ...state, status: event.status };
    }
    case "STOP":
      return {
        ...state,
        status: "stopping",
        chatId: event.chatId,
        userStopped: true,
        stoppedChatId: event.chatId,
      };
    case "NETWORK_ERROR":
      return { ...state, lastErrorWasNetwork: true };
    case "NON_NETWORK_ERROR":
      return { ...state, lastErrorWasNetwork: false, status: "error" };
    case "FINISH_OK":
      return { ...state, status: "settling", chatId: event.chatId, lastErrorWasNetwork: false };
    case "FINISH_DETACHED":
      return { ...state, status: "detached", chatId: event.chatId };
    case "DETACH":
      return { ...state, status: "detached" };
    case "THREAD_SWITCH":
      return {
        status: state.status === "streaming" || state.status === "submitted" ? "detached" : "idle",
        chatId: event.chatId,
        userStopped: state.stoppedChatId === event.chatId,
        stoppedChatId: state.stoppedChatId,
        lastErrorWasNetwork: false,
      };
    case "RESUME_START":
      return { ...state, status: "resuming", chatId: event.chatId };
    case "RESUME_EMPTY":
      return { ...state, status: "settling", chatId: event.chatId };
    case "SETTLE":
      return { ...state, status: "idle", chatId: event.chatId };
    default:
      return state;
  }
}

export type TurnMachine = {
  dispatch: (event: TurnEvent) => void;
  /** Synchronously-current state for AI SDK callbacks (which close over stale
   * React state otherwise). No component renders from turn state directly —
   * rendering is driven by `useChat` status — so no React state mirror is
   * kept; the ref is the single source of truth. */
  stateRef: React.RefObject<TurnState>;
};

/** Explicit turn lifecycle used by the chat page and its hooks. */
export function useTurnMachine(initialChatId: string): TurnMachine {
  const stateRef = useRef<TurnState>({
    ...initialTurnState,
    chatId: initialChatId,
  });

  const dispatch = useCallback((event: TurnEvent) => {
    stateRef.current = turnReducer(stateRef.current, event);
  }, []);

  return { dispatch, stateRef };
}
