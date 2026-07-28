"use client";

import { useEffect, useRef, useState } from "react";
import type { UIMessage } from "ai";

export type Heartbeat = { elapsed: number; idle: number };

/**
 * While a request is in flight the server may spend long stretches on tool
 * calls / summarization with no visible tokens. Tick a live "still working"
 * clock (total elapsed + time since the last message activity) so the UI never
 * looks frozen or dead.
 */
export function useHeartbeat(
  isBusy: boolean,
  messages: UIMessage[],
): Heartbeat {
  const [heartbeat, setHeartbeat] = useState<Heartbeat>({ elapsed: 0, idle: 0 });
  const lastActivityRef = useRef(Date.now());

  useEffect(() => {
    lastActivityRef.current = Date.now();
  }, [messages]);

  useEffect(() => {
    if (!isBusy) {
      setHeartbeat({ elapsed: 0, idle: 0 });
      return;
    }
    const start = Date.now();
    lastActivityRef.current = start;
    const id = window.setInterval(() => {
      const now = Date.now();
      setHeartbeat({
        elapsed: Math.floor((now - start) / 1000),
        idle: Math.floor((now - lastActivityRef.current) / 1000),
      });
    }, 1000);
    return () => window.clearInterval(id);
  }, [isBusy]);

  return heartbeat;
}
