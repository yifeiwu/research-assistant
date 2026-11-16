import { describe, expect, it } from "vitest";
import {
  finishDurableTurn,
  isTurnCancelled,
  readDurableTurn,
  startDurableTurn,
  stopDurableTurn,
  updateDurableTurnProgress,
  type TurnStoreDb,
} from "@/lib/agent/turn-store";
import { serverConfig } from "@/lib/config";
import { FakeRedis } from "./fake-redis";

const CHAT = "chat-durable-1234";

describe("durable Redis turn store", () => {
  it("persists live research progress and final assistant answer for reload/background recovery", async () => {
    const db = new FakeRedis() as unknown as TurnStoreDb;
    let now = 10_000;

    const { state: initial, preStopped } = await startDurableTurn(CHAT, "u1", {
      db,
      now: () => now,
    });
    expect(preStopped).toBe(false);
    expect(initial.status).toBe("running");

    now += 1_000;
    await updateDurableTurnProgress(
      initial.runId,
      {
        steps: [{ round: 1, phase: "searching", query: "exa highlights", sources: [] }],
        sources: [],
      },
      { db, now: () => now },
    );

    const mid = await readDurableTurn(CHAT, { db, now: () => now });
    expect(mid?.status).toBe("running");
    expect(mid?.steps).toHaveLength(1);

    now += 2_000;
    await finishDurableTurn(
      CHAT,
      initial.runId,
      {
        status: "done",
        steps: [{ round: 1, phase: "done", query: "exa highlights", sources: [] }],
        sources: [],
        message: { id: "msg-1", role: "assistant", text: "Durable final answer." },
      },
      { db, now: () => now },
    );

    const done = await readDurableTurn(CHAT, { db, now: () => now });
    expect(done?.status).toBe("done");
    expect(done?.message?.text).toBe("Durable final answer.");
  });

  it("handles pre-start stops, mid-run stops, and superseding turns without clobbering", async () => {
    const db = new FakeRedis() as unknown as TurnStoreDb;

    // 1. Pre-start stop arrives before POST /api/chat registers the turn.
    await stopDurableTurn(CHAT, "u-early", { db });
    const pre = await startDurableTurn(CHAT, "u-early", { db });
    expect(pre.preStopped).toBe(true);
    expect(pre.state.status).toBe("stopped");

    // 2. Normal turn starts, then a newer turn supersedes it on the same chat.
    const first = await startDurableTurn(CHAT, "u1", { db });
    const second = await startDurableTurn(CHAT, "u2", { db });
    expect(await isTurnCancelled(CHAT, first.state.runId, db)).toBe(true);
    expect(await isTurnCancelled(CHAT, second.state.runId, db)).toBe(false);

    // 3. Explicit Stop on u2 marks it stopped and prevents late completion from overwriting.
    await stopDurableTurn(CHAT, "u2", { db });
    const afterLateFinish = await finishDurableTurn(
      CHAT,
      second.state.runId,
      {
        status: "done",
        steps: [],
        sources: [],
        message: { id: "m2", role: "assistant", text: "Late" },
      },
      { db },
    );
    expect(afterLateFinish.status).toBe("stopped");
  });

  it("reports abandoned running turns without recent heartbeats as interrupted errors", async () => {
    const db = new FakeRedis() as unknown as TurnStoreDb;
    const startedAt = 1_000;
    await startDurableTurn(CHAT, "u1", { db, now: () => startedAt });

    const stale = await readDurableTurn(CHAT, {
      db,
      now: () => startedAt + serverConfig.turn.staleMs + 1_000,
    });
    expect(stale?.status).toBe("error");
    expect(stale?.error).toContain("interrupted");
  });
});
