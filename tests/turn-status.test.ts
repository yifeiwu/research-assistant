import { describe, expect, it } from "vitest";
import { activeTurnStatus, turnStatusLabel } from "@/lib/turn-status";

const part = (data: unknown) => ({ type: "data-turn-status", id: "turn-status-x", data });

describe("activeTurnStatus", () => {
  it("returns a queued or waiting status", () => {
    const queued = { state: "queued", position: 2 };
    expect(activeTurnStatus({ parts: [part(queued), { type: "text" }] })).toEqual(queued);
  });

  it("is null once the status was cleared", () => {
    expect(activeTurnStatus({ parts: [part({ state: "clear" })] })).toBeNull();
  });
});

describe("turnStatusLabel", () => {
  it("counts down to the rate-limit window and names the model and stage", () => {
    const status = {
      state: "waiting" as const,
      stage: "answering" as const,
      modelLabel: "GPT-OSS 120B",
      resumeAt: 20_000,
    };
    expect(turnStatusLabel(status, 7_500)).toBe(
      "Waiting for GPT-OSS 120B's rate limit before writing the answer. Resuming in 13s.",
    );
    // Past the expected time (or a skewed client clock): no negative countdown.
    expect(turnStatusLabel(status, 25_000)).toContain("Resuming any moment.");
  });
});
