"use client";

import { useEffect, useState } from "react";
import { Hourglass } from "lucide-react";
import type { TurnStatusData } from "@/lib/types/chat";
import { turnStatusLabel } from "@/lib/turn-status";

/**
 * Shown while a turn is queued for a research slot or waiting for a model's
 * rate-limit window, so a pause reads as a wait and not as a hang.
 */
export function TurnStatus({
  status,
}: {
  status: Exclude<TurnStatusData, { state: "clear" }>;
}) {
  const [now, setNow] = useState(() => Date.now());
  const ticking = status.state === "waiting";

  useEffect(() => {
    if (!ticking) return;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [ticking]);

  return (
    <div
      role="status"
      className="my-2 inline-flex items-center gap-1.5 rounded-lg border border-border bg-surface-2/60 px-2.5 py-1 text-xs text-muted"
    >
      <Hourglass className="h-3.5 w-3.5 shrink-0" aria-hidden />
      <span className="tabular-nums">{turnStatusLabel(status, now)}</span>
    </div>
  );
}
