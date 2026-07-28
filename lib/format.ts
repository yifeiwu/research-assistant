/** Label for the in-flight status indicator, based on stream status + idle time. */
export function busyLabel(status: string, idleSeconds: number): string {
  if (status === "submitted") return "Thinking…";
  // Streaming: if no new output has arrived for a few seconds, the model is
  // likely searching/reading/summarizing. Reassure the user it's still alive.
  if (idleSeconds >= 4) return "Still working — searching and reading sources…";
  return "Responding…";
}

/** Format a duration in seconds as `12s` or `1m 05s`. */
export function formatDuration(totalSeconds: number): string {
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${seconds.toString().padStart(2, "0")}s`;
}
