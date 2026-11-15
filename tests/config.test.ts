import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { serverConfig } from "@/lib/config";

/** The `maxDuration` a route file declares, in ms. */
function routeLimitMs(path: string): number {
  const source = readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), "utf8");
  const match = /^export const maxDuration = (\d+);$/m.exec(source);
  if (!match) throw new Error(`${path} declares no maxDuration`);
  return Number(match[1]) * 1_000;
}

/**
 * A turn's timings are spread over lib/config.ts and the two routes that can
 * run one. Nothing else ties them together, and getting them wrong shows up
 * only as answers cut off part-way, which cannot be retried.
 */
describe("turn timings fit inside a function invocation", () => {
  const { detached, synthesis, groqRateLimit } = serverConfig;

  it("config and both turn-running routes agree on how long an invocation lasts", () => {
    expect(routeLimitMs("app/api/chat/route.ts")).toBe(detached.invocationLimitMs);
    expect(routeLimitMs("app/api/chat/[id]/stream/route.ts")).toBe(detached.invocationLimitMs);
  });

  it("an answer started at the last moment still has a usable window", () => {
    // The latest an answer may start: just before the hand-over point, and
    // then a full wait for its model's rate-limit window.
    const latestStartMs = detached.handoffAfterMs + groqRateLimit.budgetWait.synthesisMs;
    const windowMs = detached.invocationLimitMs - detached.finishMarginMs - latestStartMs;
    // Below `minWindowMs` the turn would be handed over instead of answered,
    // every time, by an invocation that had already done the waiting.
    expect(windowMs).toBeGreaterThanOrEqual(synthesis.minWindowMs);
  });
});
