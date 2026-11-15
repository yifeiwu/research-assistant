"use client";

import { useEffect, useRef, useState } from "react";
import type { UIMessage } from "ai";

export type Heartbeat = { elapsed: number; idle: number };

const RESTING: Heartbeat = { elapsed: 0, idle: 0 };

/**
 * While a turn is in flight the server may spend long stretches on research
 * with no visible tokens. Tick a live "still working" clock (total elapsed +
 * time since the last message activity) so the UI never looks frozen or dead.
 *
 * `startedAt` is when the turn was sent. Elapsed time counts from there, so
 * the clock carries on across a reconnect instead of starting again; without
 * it, it counts from when `active` turned true.
 */
export function useHeartbeat(
  active: boolean,
  messages: UIMessage[],
  startedAt?: number,
): Heartbeat {
  const [heartbeat, setHeartbeat] = useState<Heartbeat>(RESTING);
  const lastActivityRef = useRef(0);

  useEffect(() => {
    lastActivityRef.current = Date.now();
  }, [messages, active]);

  useEffect(() => {
    if (!active) {
      setHeartbeat((prev) => (prev.elapsed === 0 && prev.idle === 0 ? prev : RESTING));
      return;
    }
    const start = startedAt ?? Date.now();
    const tick = () => {
      if (document.visibilityState !== "visible") return;
      const now = Date.now();
      const elapsed = Math.max(0, Math.floor((now - start) / 1000));
      const idle = Math.max(0, Math.floor((now - lastActivityRef.current) / 1000));
      setHeartbeat((prev) =>
        prev.elapsed === elapsed && prev.idle === idle ? prev : { elapsed, idle },
      );
    };
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, [active, startedAt]);

  return heartbeat;
}
