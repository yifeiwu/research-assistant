import type { ResearchStepData, TurnWaitState } from "@/lib/types/chat";

const STAGE_LABELS: Record<
  Extract<TurnWaitState, { kind: "rate-limit" }>["stage"],
  string
> = {
  planning: "planning searches",
  reading: "reading sources",
  answering: "writing the answer",
};

/** Label for the in-flight turn status indicator, including queue & budget waits. */
export function busyLabel(
  steps: ResearchStepData[],
  wait?: TurnWaitState,
  nowMs?: number,
): string {
  if (wait?.kind === "queued") {
    return wait.position <= 1
      ? "In queue — you're next…"
      : `In queue (position ${wait.position})…`;
  }
  if (wait?.kind === "rate-limit") {
    const secs =
      nowMs != null ? Math.max(0, Math.ceil((wait.resumeAt - nowMs) / 1_000)) : 0;
    const stageText = STAGE_LABELS[wait.stage];
    return secs > 0
      ? `Waiting for model quota before ${stageText} (${secs}s)…`
      : `Resuming ${stageText}…`;
  }

  if (steps.length === 0) return "Thinking…";
  const last = steps[steps.length - 1];
  switch (last.phase) {
    case "planning":
      return "Planning search…";
    case "searching":
      return "Searching the web…";
    case "reading":
      return "Reading sources…";
    case "checking-gaps":
      return "Checking research gaps…";
    default:
      return "Writing answer…";
  }
}

/** Format a duration in seconds as `12s` or `1m 05s`. */
export function formatDuration(totalSeconds: number): string {
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${seconds.toString().padStart(2, "0")}s`;
}
