"use client";

import { useEffect, useState } from "react";

export type Heartbeat = {
  elapsed: number;
  now: number;
};

const RESTING: Heartbeat = { elapsed: 0, now: 0 };

/**
 * Live 1-second clock while a durable turn is active, supplying both `elapsed`
 * seconds and `now` (epoch ms) for rate-limit countdowns without calling
 * `Date.now()` impurely during React render.
 */
export function useHeartbeat(active: boolean, startedAt?: number): Heartbeat {
  const [beat, setBeat] = useState<Heartbeat>(RESTING);

  useEffect(() => {
    if (!active) return;
    const start = startedAt ?? Date.now();
    const tick = () => {
      if (document.visibilityState !== "visible") return;
      const now = Date.now();
      const elapsed = Math.max(0, Math.floor((now - start) / 1000));
      setBeat({ elapsed, now });
    };
    const initial = window.setTimeout(tick, 0);
    const id = window.setInterval(tick, 1000);
    document.addEventListener("visibilitychange", tick);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [active, startedAt]);

  return active ? beat : RESTING;
}
