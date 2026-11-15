"use client";

import { RotateCw } from "lucide-react";

/** Why a thread's latest message has no answer, when that is known. */
export type UnansweredReason = "stopped" | "expired";

const EXPLANATION: Record<UnansweredReason | "unknown", string> = {
  stopped: "You stopped this response before it answered.",
  expired:
    "The answer to this message is no longer available. It may have expired while this page was away.",
  unknown: "This message was not answered.",
};

/**
 * Shown under a thread that ends without an answer, so there is always a way
 * to ask again.
 */
export function UnansweredNotice({
  reason,
  onRetry,
}: {
  reason?: UnansweredReason;
  onRetry: () => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-xl border border-border bg-surface-2/60 px-4 py-3 text-sm text-muted">
      <span>{EXPLANATION[reason ?? "unknown"]}</span>
      <button
        type="button"
        onClick={onRetry}
        className="flex shrink-0 items-center gap-1.5 rounded-lg border border-border bg-surface px-2.5 py-1 text-xs font-medium text-foreground transition hover:border-accent"
      >
        <RotateCw className="h-3.5 w-3.5" aria-hidden /> Retry
      </button>
    </div>
  );
}
