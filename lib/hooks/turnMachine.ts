"use client";

import { useCallback, useEffect, useReducer, useRef } from "react";

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
  /** Active chat whose stream the UI is currently attached to. */
  activeChatId: string | null;
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
  activeChatId: null,
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
        activeChatId: event.chatId,
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
      return {
        ...state,
        status: event.status,
        activeChatId: event.chatId ?? state.activeChatId ?? state.chatId,
      };
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
      return { ...state, status: "detached", activeChatId: event.chatId };
    case "THREAD_SWITCH":
      return {
        status: state.status === "streaming" || state.status === "submitted" ? "detached" : "idle",
        chatId: event.chatId,
        activeChatId: event.chatId,
        userStopped: state.stoppedChatId === event.chatId,
        stoppedChatId: state.stoppedChatId,
        lastErrorWasNetwork: false,
      };
    case "RESUME_START":
      return { ...state, status: "resuming", chatId: event.chatId, activeChatId: event.chatId };
    case "RESUME_EMPTY":
      return { ...state, status: "settling", chatId: event.chatId };
    case "SETTLE":
      return { ...state, status: "idle", chatId: event.chatId };
    default:
      return state;
  }
}

export type TurnMachine = {
  state: TurnState;
  dispatch: (event: TurnEvent) => void;
  /** Ref mirrors, kept synchronously current for AI SDK callbacks. */
  stateRef: React.RefObject<TurnState>;
  userStoppedRef: React.RefObject<boolean>;
  activeStreamChatIdRef: React.RefObject<string>;
};

/** Explicit turn lifecycle used by the chat page and its hooks. */
export function useTurnMachine(initialChatId: string): TurnMachine {
  const [state, baseDispatch] = useReducer(turnReducer, {
    ...initialTurnState,
    chatId: initialChatId,
    activeChatId: initialChatId,
  });
  const stateRef = useRef(state);
  const userStoppedRef = useRef(false);
  const activeStreamChatIdRef = useRef(initialChatId);

  const dispatch = useCallback((event: TurnEvent) => {
    const next = turnReducer(stateRef.current, event);
    stateRef.current = next;
    userStoppedRef.current = next.userStopped;
    if (next.activeChatId) activeStreamChatIdRef.current = next.activeChatId;
    baseDispatch(event);
  }, []);

  useEffect(() => {
    stateRef.current = state;
    userStoppedRef.current = state.userStopped;
    if (state.activeChatId) activeStreamChatIdRef.current = state.activeChatId;
  }, [state]);

  return { state, dispatch, stateRef, userStoppedRef, activeStreamChatIdRef };
}
