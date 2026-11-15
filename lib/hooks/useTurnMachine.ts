"use client";

import { useCallback, useRef, useState } from "react";
import {
  initialTurnState,
  turnReducer,
  type TurnEvent,
  type TurnState,
} from "@/lib/turn-machine";

export type TurnMachine = {
  /** For rendering. */
  state: TurnState;
  /** Apply an event. Returns the state it led to. */
  dispatch: (event: TurnEvent) => TurnState;
  /**
   * The state as of the last `dispatch`, for callbacks that run between
   * renders (the AI SDK's, and timers).
   */
  getState: () => TurnState;
};

/** The page's turn state (lib/turn-machine.ts), held in React. */
export function useTurnMachine(initialChatId: string): TurnMachine {
  const [state, setState] = useState(() => initialTurnState(initialChatId));
  const latest = useRef(state);

  const dispatch = useCallback((event: TurnEvent) => {
    const next = turnReducer(latest.current, event);
    if (next !== latest.current) {
      latest.current = next;
      setState(next);
    }
    return next;
  }, []);

  const getState = useCallback(() => latest.current, []);

  return { state, dispatch, getState };
}
