import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { serverConfig } from "@/lib/config";

function routeLimitMs(path: string): number {
  const source = readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), "utf8");
  const match = /^export const maxDuration = (\d+);$/m.exec(source);
  if (!match) throw new Error(`${path} declares no maxDuration`);
  return Number(match[1]) * 1_000;
}

describe("turn timings fit inside a function invocation", () => {
  const { turn, synthesis } = serverConfig;

  it("config and /api/chat agree on maxDuration", () => {
    expect(routeLimitMs("app/api/chat/route.ts")).toBe(turn.invocationLimitMs);
  });

  it("synthesis timeout leaves comfortable room inside the invocation limit", () => {
    expect(synthesis.totalTimeoutMs).toBeLessThan(turn.invocationLimitMs);
    expect(turn.heartbeatMs).toBeLessThan(turn.staleMs);
  });
});
