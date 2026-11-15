import { describe, expect, it } from "vitest";
import {
  createAdmissionQueue,
  createMemoryAdmissionStore,
  type AdmissionTicket,
} from "@/lib/agent/admission";
import { BudgetDeniedError, type StageRunner } from "@/lib/agent/stage";
import { startTurn, type TurnCheckpoint, type TurnInput } from "@/lib/agent/turn";
import { serverConfig } from "@/lib/config";
import { effortConfig } from "@/lib/effort";
import {
  FALLBACK,
  OUTCOME,
  SELECTED,
  fakeTurnDeps,
  model,
  readAll,
} from "./turn-fakes";

function harness(opts?: {
  /** Behaviour of the synthesis lease; defaults to granting the selected model. */
  synthesisLease?: StageRunner["lease"];
  onResearch?: () => void;
  now?: () => number;
}) {
  const fakes = fakeTurnDeps({
    synthesisLease: () => opts?.synthesisLease,
    onResearch: opts?.onResearch,
    now: opts?.now,
  });

  /** Run one attempt to the end of its stream. */
  const run = async (over?: Partial<TurnInput>) => {
    const saved: TurnCheckpoint[] = [];
    const turn = startTurn({
      requestId: "req12345",
      threadId: "chat-thread-1",
      query: "what is new?",
      effort: effortConfig("medium"),
      modelMessages: [{ role: "user", content: "what is new?" }],
      signal: new AbortController().signal,
      emitStart: true,
      saveCheckpoint: async (checkpoint) => {
        saved.push(checkpoint);
      },
      maxDeferMs: 90_000,
      answerBy: Number.POSITIVE_INFINITY,
      finishBy: Number.POSITIVE_INFINITY,
      deps: fakes.deps,
      ...over,
    });
    if ("error" in turn) throw new Error("unexpected resolution error");
    const events = (await readAll(turn.stream)) as Array<Record<string, unknown>>;
    return {
      events,
      types: events.map((e) => e.type as string),
      deferral: await turn.deferral,
      saved,
    };
  };

  return { ...fakes, run };
}

/** A one-slot queue whose slot is already taken by another turn. */
async function busyQueue() {
  const other: AdmissionTicket = { id: "other", enqueuedAt: 0 };
  const queue = createAdmissionQueue({
    store: createMemoryAdmissionStore(),
    config: { maxConcurrentTurns: 1, maxQueueLength: 5 },
    now: () => 0,
  });
  await queue.poll(other);
  const ticket: AdmissionTicket = { id: "mine", enqueuedAt: 1 };
  return { queue, other, ticket };
}

const statusData = (events: Array<Record<string, unknown>>) =>
  events.filter((e) => e.type === "data-turn-status").map((e) => e.data);

describe("startTurn", () => {
  it("runs research through the budgeted stages, then streams the answer", async () => {
    const h = harness();
    const { types, events, deferral } = await h.run();

    expect(types[0]).toBe("start");
    expect(types).toContain("text-delta");
    expect(types.at(-1)).toBe("finish");
    expect(deferral).toBeUndefined();
    expect(statusData(events)).toEqual([]);

    expect(h.calls.research).toHaveLength(1);
    expect(h.calls.research[0].threadId).toBe("chat-thread-1");
    expect(h.calls.research[0].stages.planner).toBe(h.resolved.stages.planner);
    expect(h.calls.research[0].stages.summary).toBe(h.resolved.stages.summary);

    expect(h.calls.synthesis).toHaveLength(1);
    expect(h.calls.synthesis[0].model).toEqual(model(SELECTED));
    expect(h.calls.synthesis[0].system).toContain("[1] Example evidence");
    expect(h.calls.synthesis[0].maxRetries).toBe(0);
  });

  it("answers on the model the scheduler leased, sized for that model", async () => {
    const leaseRequests: Array<Parameters<StageRunner["lease"]>[0]> = [];
    const h = harness({
      synthesisLease: async (req) => {
        leaseRequests.push(req);
        return { model: model(FALLBACK), modelId: FALLBACK, waitedMs: 0 };
      },
    });
    await h.run();

    expect(h.calls.synthesis[0].model).toEqual(model(FALLBACK));
    const sizeFor = leaseRequests[0].maxOutputTokens as (id: string) => number;
    expect(h.calls.synthesis[0].maxOutputTokens).toBe(sizeFor(FALLBACK));
    expect(leaseRequests[0].estInputTokens).toBeGreaterThan(0);
  });

  it("shows scheduler waits as a status and clears it when the stage resumes", async () => {
    const h = harness({
      synthesisLease: async () => {
        h.handlers().onStatus?.({
          kind: "waiting",
          stage: "synthesis",
          model: SELECTED,
          resumeAt: 9_000,
        });
        h.handlers().onStatus?.({ kind: "resumed", stage: "synthesis" });
        return { model: model(SELECTED), modelId: SELECTED, waitedMs: 8_000 };
      },
    });
    const { events } = await h.run();

    expect(statusData(events)).toEqual([
      { state: "waiting", stage: "answering", modelLabel: expect.any(String), resumeAt: 9_000 },
      { state: "clear" },
    ]);
    // One part, replaced in place.
    const ids = events.filter((e) => e.type === "data-turn-status").map((e) => e.id);
    expect(new Set(ids).size).toBe(1);
  });

  it("defers at once while still in line, keeping its place, then runs and frees the slot", async () => {
    const h = harness();
    const { queue, other, ticket } = await busyQueue();
    const admission = { queue, ticket, deferDelayMs: 3_000 };

    const queued = await h.run({ admission });
    expect(queued.deferral).toMatchObject({ reason: "queued", delayMs: 3_000 });
    expect(statusData(queued.events)).toEqual([{ state: "queued", position: 1 }]);
    // Nothing terminal: a later attempt continues this stream.
    expect(queued.types).not.toContain("finish");
    expect(queued.types).not.toContain("error");
    expect(h.calls.research).toHaveLength(0);

    // The other turn finishes; a newcomer still has to wait behind this one.
    await queue.cancel(other);
    expect(await queue.poll({ id: "next", enqueuedAt: 2 })).toEqual({ state: "queued", position: 2 });

    const admitted = await h.run({ admission, emitStart: false });
    expect(statusData(admitted.events)).toEqual([{ state: "clear" }]);
    expect(admitted.types.at(-1)).toBe("finish");
    expect(h.calls.research).toHaveLength(1);
    // The slot was released when the stream ended.
    expect(await queue.poll({ id: "next", enqueuedAt: 2 })).toEqual({ state: "granted" });
  });

  it("does not line up again to answer once its research is checkpointed", async () => {
    const h = harness();
    const untouchable = () => {
      throw new Error("the queue must not be consulted");
    };
    const { types } = await h.run({
      checkpoint: { outcome: OUTCOME },
      admission: {
        queue: { enabled: true, poll: untouchable, hold: untouchable, cancel: untouchable },
        ticket: { id: "mine", enqueuedAt: 1 },
        deferDelayMs: 3_000,
      },
    });

    expect(types.at(-1)).toBe("finish");
    expect(h.calls.research).toHaveLength(0);
    expect(h.calls.synthesis).toHaveLength(1);
  });

  it("fails with a busy error and leaves the queue once it may no longer defer", async () => {
    const h = harness();
    const { queue, other, ticket } = await busyQueue();
    // No `deferDelayMs`: the turn has been queued for too long.
    const { types, events } = await h.run({ admission: { queue, ticket } });

    expect(types).toContain("error");
    expect(String(events.find((e) => e.type === "error")?.errorText)).toMatch(
      /server is busy with other research requests/i,
    );
    expect(h.calls.research).toHaveLength(0);
    // The ticket is gone: once the slot frees, a newcomer gets it directly.
    await queue.cancel(other);
    expect(await queue.poll({ id: "next", enqueuedAt: 2 })).toEqual({ state: "granted" });
  });

  it("answers anyway, unbudgeted, when the window never reopens or is too far away to defer for", async () => {
    for (const waitMs of [Number.POSITIVE_INFINITY, 120_000]) {
      const h = harness({
        synthesisLease: async () => {
          throw new BudgetDeniedError("synthesis", waitMs);
        },
      });
      const { types, deferral } = await h.run({ maxDeferMs: 90_000 });
      expect(deferral).toBeUndefined();
      expect(types.at(-1)).toBe("finish");
      expect(h.calls.synthesis[0].model).toBe(h.resolved.mainModel);
    }
  });

  it("leaves the answer to a later attempt rather than starting it too late", async () => {
    const clock = { now: 0 };
    const h = harness({
      now: () => clock.now,
      // Research (with its rate-limit waits) used up most of the invocation.
      onResearch: () => {
        clock.now = 151_000;
      },
    });
    const { types, deferral, saved } = await h.run({ answerBy: 150_000 });

    // The research is kept for the next attempt, and no answer was started.
    expect(saved).toHaveLength(1);
    expect(deferral).toMatchObject({ reason: "handoff", delayMs: 0 });
    expect(h.calls.synthesis).toHaveLength(0);
    // No terminal frame: the next attempt continues this stream.
    expect(types).not.toContain("finish");
    expect(types).not.toContain("error");
  });

  it("gives the answer no longer than is left of the invocation", async () => {
    const h = harness({ now: () => 200_000 });

    // Plenty of time: the configured timeouts apply.
    await h.run();
    expect(h.calls.synthesis[0].timeout).toEqual({
      totalMs: serverConfig.synthesis.totalTimeoutMs,
      stepMs: serverConfig.synthesis.stepTimeoutMs,
    });

    // 90s left: the answer times out then, not when the function is killed.
    await h.run({ finishBy: 290_000 });
    expect(h.calls.synthesis[1].timeout).toEqual({ totalMs: 90_000, stepMs: 90_000 });
  });

  it("hands the turn over when waiting for the model left too little time to answer", async () => {
    const clock = { now: 140_000 };
    const h = harness({
      now: () => clock.now,
      // The wait for the model's rate-limit window ran long.
      synthesisLease: async () => {
        clock.now = 270_000;
        return { model: model(SELECTED), modelId: SELECTED, waitedMs: 130_000 };
      },
    });
    const { types, deferral, saved } = await h.run({ answerBy: 150_000, finishBy: 290_000 });

    expect(deferral).toMatchObject({ reason: "handoff", delayMs: 0 });
    expect(h.calls.synthesis).toHaveLength(0);
    // Research is kept, and nothing terminal was written.
    expect(saved).toHaveLength(1);
    expect(types).not.toContain("finish");
    expect(types).not.toContain("error");
  });

  it("stops before doing any work when the turn was already aborted", async () => {
    const h = harness();
    const controller = new AbortController();
    controller.abort();
    const { types } = await h.run({ signal: controller.signal });

    expect(types).toContain("abort");
    expect(h.calls.research).toHaveLength(0);
  });

  it("adapts synthesis prompt depth to effort level and switches to compact prompt on Qwen fallback", async () => {
    const hDeep = harness();
    await hDeep.run({ effort: effortConfig("high") });
    expect(hDeep.calls.synthesis[0].system).toContain("Depth & Structure (Deep Research)");
    expect(hDeep.calls.synthesis[0].providerOptions).toEqual({
      groq: { reasoningFormat: "parsed", reasoningEffort: "medium" },
    });

    const hQwenFallback = harness({
      synthesisLease: async () => ({
        model: model("qwen/qwen3.8-27b"),
        modelId: "qwen/qwen3.8-27b",
        waitedMs: 0,
      }),
    });
    await hQwenFallback.run({ effort: effortConfig("high") });
    expect(hQwenFallback.calls.synthesis[0].maxOutputTokens).toBe(900);
    expect(hQwenFallback.calls.synthesis[0].system).toContain(
      "Depth & Structure (Compact Output Budget)",
    );
    expect(hQwenFallback.calls.synthesis[0].providerOptions).toEqual({
      groq: { reasoningFormat: "parsed" },
    });
  });
});
