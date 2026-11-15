import type { UIMessage } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createAdmissionQueue,
  createMemoryAdmissionStore,
  type AdmissionTicket,
} from "@/lib/agent/admission";
import {
  resumeChatStream,
  runLeaseKey,
  startChatStream,
  stopChatStream,
} from "@/lib/agent/chat-stream";
import {
  driveDetachedTurn,
  saveDetachedTurn,
  tailDetachedTurn,
  type ChatJob,
  type DriveDeps,
  type DriveOrigin,
} from "@/lib/agent/detached";
import { BudgetDeniedError, type StageRunner } from "@/lib/agent/stage";
import { startTurn } from "@/lib/agent/turn";
import type { runResearchPipeline } from "@/lib/research";
import { FakeRedis } from "./fake-redis";
import { fakeTurnDeps, sseEvents } from "./turn-fakes";

const CHAT = "chat-detached-1";
type Db = NonNullable<DriveDeps["db"]>;

const MESSAGES: UIMessage[] = [
  { id: "u1", role: "user", parts: [{ type: "text", text: "what is new?" }] },
];

async function setup(opts?: {
  /** Start with the only research slot taken by another turn. */
  busy?: boolean;
  ticket?: boolean;
  config?: DriveDeps["config"];
}) {
  const fake = new FakeRedis();
  const db = fake as unknown as Db;
  const clock = { now: 10_000 };
  /** Every wait a driver made, in order. Waiting moves the clock on. */
  const sleeps: number[] = [];
  /** What happens in the world while the code under test is busy. */
  const hooks: {
    onSleep?: (ms: number) => void | Promise<void>;
    onResearch?: (input: Parameters<typeof runResearchPipeline>[0]) => void | Promise<void>;
  } = {};

  let synthesisLease: StageRunner["lease"] | undefined;
  const fakes = fakeTurnDeps({
    synthesisLease: () => synthesisLease,
    onResearch: (input) => hooks.onResearch?.(input),
    now: () => clock.now,
  });

  const other: AdmissionTicket = { id: "other", enqueuedAt: 0 };
  const queue = createAdmissionQueue({
    store: createMemoryAdmissionStore(),
    config: { maxConcurrentTurns: 1, maxQueueLength: 5 },
    now: () => clock.now,
  });
  if (opts?.busy) await queue.poll(other);

  const { runId } = await startChatStream(CHAT, "u1", db);
  const job: ChatJob = {
    runId,
    chatId: CHAT,
    requestId: "req12345",
    effort: "medium",
    messages: MESSAGES,
    query: "what is new?",
    ticket: opts?.ticket === false ? undefined : { id: "mine", enqueuedAt: 1 },
    createdAt: clock.now,
  };
  await saveDetachedTurn(job, db);

  const deps: DriveDeps = {
    db,
    queue,
    startTurn: (input) => startTurn({ ...input, deps: fakes.deps }),
    config: { queuePollDelayMs: 5_000, ...opts?.config },
    maxQueueWaitMs: 120_000,
    now: () => clock.now,
    sleep: async (ms) => {
      sleeps.push(ms);
      await hooks.onSleep?.(ms);
      clock.now += ms;
    },
  };

  type Over = {
    origin?: DriveOrigin;
    /** When the invocation began; now, unless given. */
    startedAt?: number;
    config?: DriveDeps["config"];
    startTurn?: DriveDeps["startTurn"];
  };
  const depsFor = (over?: Over): DriveDeps => ({
    ...deps,
    ...(over?.startTurn ? { startTurn: over.startTurn } : {}),
    config: { ...deps.config, ...over?.config },
  });
  /** One invocation driving the run for as long as it can. */
  const drive = (over?: Over) =>
    driveDetachedTurn(
      job.runId,
      { origin: over?.origin ?? "start", startedAt: over?.startedAt ?? clock.now },
      depsFor(over),
    );
  /** An invocation with no time to wait: it hands over a run that defers. */
  const step = (over?: Over) => drive({ ...over, config: { handoffAfterMs: 1_000, ...over?.config } });

  /** A request for the run, with the work it left running behind its response. */
  const request = async (origin: DriveOrigin, over?: Over) => {
    const background: Promise<unknown>[] = [];
    const response = await tailDetachedTurn(
      {
        chatId: CHAT,
        runId: job.runId,
        origin,
        startedAt: over?.startedAt ?? clock.now,
        signal: new AbortController().signal,
        keepAlive: (work) => background.push(work),
      },
      depsFor(over),
    );
    return { response, settled: () => Promise.all(background) };
  };

  /** Whether a newcomer would be admitted straight away once `other` is gone. */
  const lineIsClear = async () => {
    await queue.cancel(other);
    const newcomer: AdmissionTicket = { id: "newcomer", enqueuedAt: 99 };
    const state = await queue.poll(newcomer);
    await queue.cancel(newcomer);
    return state.state === "granted";
  };

  /** Everything buffered for the run so far, as a client would replay it. */
  const buffered = () => (fake.lists.get(`chat:run:${job.runId}:chunks`) ?? []).join("");
  const meta = () => fake.hashes.get(`chat:run:${job.runId}:meta`) ?? {};
  const leaseHolder = () => fake.strings.get(runLeaseKey(job.runId));

  return {
    fake,
    db,
    clock,
    sleeps,
    hooks,
    queue,
    other,
    job,
    drive,
    step,
    request,
    lineIsClear,
    buffered,
    meta,
    leaseHolder,
    calls: fakes.calls,
    setSynthesisLease: (lease: StageRunner["lease"] | undefined) => {
      synthesisLease = lease;
    },
  };
}

const count = (text: string, needle: string) => text.split(needle).length - 1;
const types = (sse: string) => sseEvents(sse).map((e) => e.type);
const errorText = (sse: string) =>
  String(sseEvents(sse).find((e) => e.type === "error")?.errorText);
const boom = () => {
  throw new Error("boom");
};

describe("driveDetachedTurn", () => {
  it("runs the turn into the run buffer, where a client can tail it", async () => {
    const t = await setup();
    expect(await t.drive()).toBe("done");

    expect(t.meta().status).toBe("done");
    // Recorded so that a crash after this point is not retried.
    expect(t.meta().answerStarted).toBe("1");
    expect(types(t.buffered())).toEqual(expect.arrayContaining(["start", "text-delta", "finish"]));
    expect(t.buffered().endsWith("data: [DONE]\n\n")).toBe(true);

    const replay = await resumeChatStream(CHAT, undefined, { runId: t.job.runId }, t.db);
    expect(await replay!.text()).toBe(t.buffered());

    // Nothing is left behind for a later request to pick up.
    expect(t.fake.strings.has(`chat:job:${t.job.runId}`)).toBe(false);
    expect(t.leaseHolder()).toBeUndefined();
    expect(await t.drive({ origin: "resume" })).toBe("done");
    expect(t.calls.research).toHaveLength(1);
  });

  it("waits in line without giving up the run, then finishes the turn as one message", async () => {
    const t = await setup({ busy: true });
    t.hooks.onSleep = async () => {
      expect(t.meta().status).toBe("waiting");
      expect(Number(t.meta().wakeAt)).toBe(t.clock.now + 5_000);
      // Waiting in line does not use up an attempt, and the stream stays open.
      expect(Number(t.meta().attempts)).toBe(0);
      expect(t.buffered()).not.toContain("[DONE]");
      expect(sseEvents(t.buffered()).at(-1)).toMatchObject({
        type: "data-turn-status",
        data: { state: "queued", position: 1 },
      });
      expect(t.calls.research).toHaveLength(0);
      // Still this invocation's run: no other request may start driving it.
      expect(t.leaseHolder()).toBeDefined();
      await t.queue.cancel(t.other);
    };

    expect(await t.drive()).toBe("done");

    expect(t.sleeps).toEqual([5_000]);
    const sse = t.buffered();
    expect(count(sse, '"type":"start"')).toBe(1);
    expect(count(sse, '"type":"finish"')).toBe(1);
    expect(count(sse, "[DONE]")).toBe(1);
    expect(sseEvents(sse).filter((e) => e.type === "data-turn-status").at(-1)).toMatchObject({
      data: { state: "clear" },
    });
    expect(t.calls.research).toHaveLength(1);
    expect(t.meta().status).toBe("done");
    expect(t.leaseHolder()).toBeUndefined();
  });

  it("fails as busy once a turn has been queued for too long", async () => {
    const t = await setup({ busy: true });
    t.clock.now += 121_000;
    await t.queue.poll(t.other); // the other turn is still running
    expect(await t.drive()).toBe("done");

    expect(t.sleeps).toEqual([]);
    expect(errorText(t.buffered())).toMatch(/server is busy with other research requests/i);
    expect(t.meta().status).toBe("done");
    // It left the queue rather than holding a place it will never use.
    await t.queue.cancel(t.other);
    expect(await t.queue.poll({ id: "next", enqueuedAt: 99 })).toEqual({ state: "granted" });
  });

  it("waits for the rate-limit window to reopen, without repeating research", async () => {
    const t = await setup();
    t.setSynthesisLease(async () => {
      throw new BudgetDeniedError("synthesis", 40_000);
    });
    t.hooks.onSleep = async () => {
      expect(t.meta().status).toBe("waiting");
      expect(Number(t.meta().attempts)).toBe(1);
      expect(t.calls.research).toHaveLength(1);
      expect(t.calls.synthesis).toHaveLength(0);
      // The research slot is free for other turns during the wait, and
      // another turn takes it.
      expect(await t.queue.poll({ id: "next", enqueuedAt: 99 })).toEqual({ state: "granted" });
      t.setSynthesisLease(undefined);
    };

    expect(await t.drive()).toBe("done");

    expect(t.sleeps).toEqual([41_000]);
    // With its research done, the turn answered without lining up again.
    expect(t.calls.research).toHaveLength(1);
    expect(t.calls.synthesis).toHaveLength(1);
    const sse = t.buffered();
    expect(count(sse, '"type":"start"')).toBe(1);
    expect(count(sse, '"type":"data-research-step"')).toBe(1);
    expect(count(sse, "[DONE]")).toBe(1);
    expect(types(sse).at(-1)).toBe("finish");
  });

  it("gives up with an error after the allowed number of attempts", async () => {
    const t = await setup({ config: { maxAttempts: 2 } });
    t.setSynthesisLease(async () => {
      throw new BudgetDeniedError("synthesis", 40_000);
    });

    expect(await t.drive()).toBe("done");

    expect(t.sleeps).toEqual([41_000, 41_000]); // two deferrals, no more
    expect(errorText(t.buffered())).toMatch(/could not be completed after several attempts/);
    expect(count(t.buffered(), "[DONE]")).toBe(1);
    expect(t.meta().status).toBe("done");
  });

  it("hands the run over when a wait would outlast the invocation, and a later request sees it through", async () => {
    const t = await setup({ busy: true });

    expect(await t.step()).toBe("handed-over");
    expect(t.sleeps).toEqual([]);
    expect(t.meta().status).toBe("waiting");
    expect(t.buffered()).not.toContain("[DONE]");
    // Free for whichever request comes next.
    expect(t.leaseHolder()).toBeUndefined();

    // One comes 2s later, before the run is due to look at the queue again.
    t.clock.now += 2_000;
    t.hooks.onSleep = () => t.queue.cancel(t.other);
    expect(await t.drive({ origin: "resume" })).toBe("done");

    expect(t.sleeps).toEqual([3_000]); // only what was left of the wait
    const sse = t.buffered();
    expect(count(sse, '"type":"start"')).toBe(1);
    expect(types(sse).at(-1)).toBe("finish");
    expect(count(sse, "[DONE]")).toBe(1);
  });

  it("starts nothing in an invocation that is already old", async () => {
    const t = await setup();

    expect(await t.drive({ origin: "resume", startedAt: t.clock.now - 200_000 })).toBe("handed-over");
    expect(t.calls.research).toHaveLength(0);
    // Parked, not abandoned: tailing clients see a run that is still in play.
    expect(t.meta().status).toBe("waiting");
    expect(Number(t.meta().attempts) || 0).toBe(0);
    expect(t.leaseHolder()).toBeUndefined();

    expect(await t.drive({ origin: "resume" })).toBe("done");
    expect(types(t.buffered()).at(-1)).toBe("finish");
  });

  it("leaves the answer to a fresh invocation when research ran long, which does not repeat it", async () => {
    const t = await setup();
    // Research (with its rate-limit waits) used up most of the invocation.
    t.hooks.onResearch = () => {
      t.clock.now += 151_000;
    };

    expect(await t.drive()).toBe("handed-over");
    expect(t.calls.research).toHaveLength(1);
    expect(t.calls.synthesis).toHaveLength(0);
    expect(t.meta().status).toBe("waiting");
    expect(t.buffered()).not.toContain("[DONE]");

    expect(await t.drive({ origin: "resume" })).toBe("done");
    expect(t.calls.research).toHaveLength(1);
    expect(t.calls.synthesis).toHaveLength(1);
    const sse = t.buffered();
    expect(count(sse, '"type":"start"')).toBe(1);
    expect(count(sse, '"type":"data-research-step"')).toBe(1);
    expect(types(sse).at(-1)).toBe("finish");
  });

  it("does nothing while another invocation is driving the run", async () => {
    const t = await setup();
    await t.fake.set(runLeaseKey(t.job.runId), "someone-else");

    expect(await t.drive({ origin: "resume" })).toBe("busy");
    expect(t.buffered()).toBe("");
    expect(t.calls.research).toHaveLength(0);
    expect(t.leaseHolder()).toBe("someone-else");
  });

  it("takes over a run whose invocation died before the answer started", async () => {
    const t = await setup();
    // Simulate an invocation that streamed research progress and then died:
    // its lease has lapsed and the run was never finished.
    await t.fake.rpush(
      `chat:run:${t.job.runId}:chunks`,
      'data: {"type":"start"}\n\ndata: {"type":"data-research-step","id":"research-r1-req12345","data":{"round":1,"phase":"searching","query":"q","sources":[]}}\n\n',
    );
    await t.fake.hset(`chat:run:${t.job.runId}:meta`, { attempts: "1" });

    expect(await t.drive({ origin: "resume" })).toBe("done");

    const sse = t.buffered();
    expect(count(sse, '"type":"start"')).toBe(1);
    // Research ran again; its progress part reuses the id, so the client
    // replaces the dead attempt's copy instead of showing two.
    const steps = sseEvents(sse).filter((e) => e.type === "data-research-step");
    expect(steps.map((s) => s.id)).toEqual(["research-r1-req12345", "research-r1-req12345"]);
    expect(types(sse).at(-1)).toBe("finish");
    expect(Number(t.meta().attempts)).toBe(2);
  });

  it("ends the run instead of answering twice when its invocation died mid-answer", async () => {
    const t = await setup();
    await t.fake.rpush(
      `chat:run:${t.job.runId}:chunks`,
      'data: {"type":"start"}\n\ndata: {"type":"text-start","id":"t1"}\n\ndata: {"type":"text-delta","id":"t1","delta":"Half an ans"}\n\n',
    );
    await t.fake.hset(`chat:run:${t.job.runId}:meta`, { answerStarted: "1", attempts: "1" });

    expect(await t.drive({ origin: "resume" })).toBe("done");

    expect(t.calls.research).toHaveLength(0);
    expect(t.calls.synthesis).toHaveLength(0);
    expect(errorText(t.buffered())).toMatch(/interrupted/);
    expect(t.buffered()).toContain("Half an ans");
    expect(t.meta().status).toBe("done");
  });

  it("does not run a turn that was stopped or replaced while it waited", async () => {
    const stopped = await setup({ busy: true });
    stopped.hooks.onSleep = async () => {
      await stopChatStream(CHAT, "u1", stopped.db);
      // The stop itself closes the stream for anyone tailing it.
      expect(stopped.meta().status).toBe("done");
      expect(types(stopped.buffered()).at(-1)).toBe("abort");
    };
    expect(await stopped.drive()).toBe("done");
    expect(count(stopped.buffered(), "[DONE]")).toBe(1);
    expect(stopped.calls.research).toHaveLength(0);
    // Its place in line and its job went with it.
    expect(await stopped.lineIsClear()).toBe(true);
    expect(stopped.fake.strings.has(`chat:job:${stopped.job.runId}`)).toBe(false);

    const replaced = await setup({ busy: true });
    expect(await replaced.step()).toBe("handed-over"); // parked
    await startChatStream(CHAT, "u2", replaced.db); // a newer turn on the chat
    expect(await replaced.drive({ origin: "resume" })).toBe("done");
    expect(types(replaced.buffered()).at(-1)).toBe("abort");
    expect(replaced.calls.research).toHaveLength(0);
    expect(await replaced.lineIsClear()).toBe(true);
  });

  it("aborts a running attempt when the user stops the turn", async () => {
    const t = await setup();
    t.hooks.onResearch = async (input) => {
      await stopChatStream(CHAT, "u1", t.db);
      // The attempt's ingester reads the stop flag from Redis at its next
      // heartbeat, a second away at most, and aborts the turn.
      await vi.waitFor(() => expect(input.signal?.aborted).toBe(true), {
        timeout: 3_000,
      });
    };

    expect(await t.drive()).toBe("done");
    expect(types(t.buffered()).at(-1)).toBe("abort");
    expect(t.calls.synthesis).toHaveLength(0);
    expect(t.meta().status).toBe("done");
  });

  it("retries an attempt that throws, a little later each time", async () => {
    const t = await setup();
    let failuresLeft = 2;
    const flaky: DriveDeps["startTurn"] = (input) => {
      if (failuresLeft-- > 0) boom();
      return startTurn({ ...input, deps: fakeTurnDeps().deps });
    };

    expect(await t.drive({ startTurn: flaky })).toBe("done");
    expect(t.sleeps).toEqual([5_000, 10_000]);
    expect(types(t.buffered()).at(-1)).toBe("finish");
    expect(t.leaseHolder()).toBeUndefined();
  });

  it("ends the run with an error once every retry has thrown, and frees its place in line", async () => {
    const t = await setup({ busy: true });
    expect(await t.step()).toBe("handed-over"); // queued, holding a place in line
    t.clock.now += 5_000;

    // Short enough that its queue ticket (20s) has not simply expired by
    // the end: the place has to be given up.
    expect(
      await t.drive({ origin: "resume", startTurn: boom, config: { retryDelayMs: 1_000 } }),
    ).toBe("done");

    expect(t.sleeps).toEqual([1_000, 2_000, 3_000]);
    expect(errorText(t.buffered())).toMatch(/could not be completed after several attempts/);
    expect(count(t.buffered(), "[DONE]")).toBe(1);
    expect(t.meta().status).toBe("done");
    expect(await t.lineIsClear()).toBe(true);
    expect(t.fake.strings.has(`chat:job:${t.job.runId}`)).toBe(false);
    expect(t.leaseHolder()).toBeUndefined();
  });

  it("hands over a run whose retry would outlast the invocation, for a later request to retry", async () => {
    const t = await setup();

    expect(await t.step({ startTurn: boom })).toBe("handed-over");
    // Parked until the retry is due, so that it is not taken for dead.
    expect(t.meta().status).toBe("waiting");
    expect(Number(t.meta().wakeAt)).toBe(t.clock.now + 5_000);
    expect(t.leaseHolder()).toBeUndefined();

    expect(await t.drive({ origin: "resume" })).toBe("done");
    expect(t.sleeps).toEqual([5_000]);
    expect(types(t.buffered()).at(-1)).toBe("finish");
  });

  it("skips unknown runs, and turns that need no research slot still run", async () => {
    const t = await setup({ ticket: false, busy: true });
    expect(
      await driveDetachedTurn("r_does-not-exist", { origin: "resume", startedAt: 0 }, { db: t.db }),
    ).toBe("done");
    expect(t.fake.strings.has(runLeaseKey("r_does-not-exist"))).toBe(false);
    // No ticket: the busy queue is not consulted at all.
    expect(await t.drive()).toBe("done");
    expect(types(t.buffered()).at(-1)).toBe("finish");
  });
});

describe("turn-summary log line", () => {
  afterEach(() => vi.restoreAllMocks());

  /** Every `turn-summary` logged since this was called. */
  function watchSummaries(): () => Array<Record<string, unknown>> {
    const log = vi.spyOn(console, "log");
    return () =>
      log.mock.calls
        .filter((call) => call[0] === "[web-seek] turn-summary")
        .map((call) => JSON.parse(String(call[1])) as Record<string, unknown>);
  }

  it("is written once when the turn is answered, with where the time went", async () => {
    const t = await setup();
    const summaries = watchSummaries();
    // Research takes 4s, and the turn was asked for 1s before it ran.
    t.hooks.onResearch = () => {
      t.clock.now += 4_000;
    };
    t.clock.now += 1_000;

    expect(await t.drive()).toBe("done");
    // A later request for the finished run adds nothing.
    expect(await t.drive({ origin: "resume" })).toBe("done");

    expect(summaries()).toEqual([
      expect.objectContaining({
        requestId: "req12345",
        runId: t.job.runId,
        outcome: "answered",
        effort: "medium",
        model: "openai/gpt-oss-120b",
        totalMs: 5_000,
        // From when its ticket was issued (at 1 on this clock) to when it
        // was given a slot (at 11,000).
        queueWaitMs: 10_999,
        research: { searched: true, sources: 1, degraded: false },
        firstTextMs: 5_000,
        answerMs: 0,
        attempts: 1,
        handOvers: 0,
        continuations: 0,
        parkedMs: 0,
      }),
    ]);
  });

  it("counts how the run was passed on, and how long it waited for a request", async () => {
    const t = await setup({ busy: true });
    const summaries = watchSummaries();

    expect(await t.step()).toBe("handed-over"); // parked, due in 5s
    expect(summaries()).toEqual([]);
    // The buffer keeps real time; put its last sign of life on the test's clock.
    t.fake.hashes.get(`chat:run:${t.job.runId}:meta`)!.updatedAt = String(t.clock.now);

    // Nobody asks after the run until 7s after it fell due.
    t.clock.now += 12_000;
    await t.queue.cancel(t.other);
    expect(await t.drive({ origin: "resume" })).toBe("done");

    expect(summaries()).toEqual([
      expect.objectContaining({
        outcome: "answered",
        // Waiting in line is not an attempt.
        attempts: 1,
        handOvers: 1,
        continuations: 1,
        parkedMs: 7_000,
        totalMs: 12_000,
      }),
    ]);
  });

  it("says how a turn ended when it was not with an answer", async () => {
    const exhausted = await setup({ config: { maxAttempts: 1 } });
    let summaries = watchSummaries();
    exhausted.setSynthesisLease(async () => {
      throw new BudgetDeniedError("synthesis", 40_000);
    });
    expect(await exhausted.drive()).toBe("done");
    expect(summaries()).toEqual([
      expect.objectContaining({ outcome: "exhausted", attempts: 1 }),
    ]);
    vi.restoreAllMocks();

    const stopped = await setup({ busy: true });
    summaries = watchSummaries();
    stopped.hooks.onSleep = () => stopChatStream(CHAT, "u1", stopped.db).then(() => {});
    expect(await stopped.drive()).toBe("done");
    expect(summaries()).toEqual([expect.objectContaining({ outcome: "cancelled" })]);
    vi.restoreAllMocks();

    const failed = await setup({ busy: true });
    summaries = watchSummaries();
    failed.clock.now += 121_000; // queued for too long
    await failed.queue.poll(failed.other);
    expect(await failed.drive()).toBe("done");
    expect(summaries()).toEqual([expect.objectContaining({ outcome: "failed" })]);
  });
});

describe("tailDetachedTurn", () => {
  it("serves the request that started a turn from the run it drives behind the response", async () => {
    const t = await setup();
    const { response, settled } = await t.request("start");

    const sse = await response!.text();
    expect(types(sse)).toEqual(expect.arrayContaining(["start", "text-delta", "finish"]));
    expect(sse.endsWith("data: [DONE]\n\n")).toBe(true);
    expect(sse).toBe(t.buffered());
    await settled();
    expect(t.leaseHolder()).toBeUndefined();
  });

  it("ends the tail without a closing frame when its invocation hands the run over", async () => {
    const t = await setup({ busy: true });
    const { response, settled } = await t.request("start", { config: { handoffAfterMs: 1_000 } });

    // The stream ends, but the turn has not: that is the client's cue to
    // reconnect (lib/unfinished-stream.ts).
    const sse = await response!.text();
    expect(sse).not.toContain("[DONE]");
    await settled();
    expect(t.meta().status).toBe("waiting");

    // The reconnect's request takes the run on and tails it to its end.
    await t.queue.cancel(t.other);
    const next = await t.request("resume");
    const replay = await next.response!.text();
    expect(count(replay, '"type":"start"')).toBe(1);
    expect(types(replay).at(-1)).toBe("finish");
    expect(replay.endsWith("data: [DONE]\n\n")).toBe(true);
    await next.settled();
  });

  it("keeps watching a run driven elsewhere, and takes it over when that invocation dies", async () => {
    const t = await setup();
    await t.fake.set(runLeaseKey(t.job.runId), "dead-invocation");
    // In Redis the dead invocation's lease expires on its own; here that
    // happens while this request waits to look again.
    t.hooks.onSleep = async () => {
      await t.fake.del(runLeaseKey(t.job.runId));
    };

    const { response, settled } = await t.request("resume");
    const sse = await response!.text();
    expect(types(sse).at(-1)).toBe("finish");
    expect(sse.endsWith("data: [DONE]\n\n")).toBe(true);
    await settled();
    expect(t.sleeps).toEqual([5_000]); // one look later
  });

  it("continues a run that has long gone quiet instead of reporting it as dead", async () => {
    const t = await setup();
    // Its invocation died before writing anything, and nobody has asked
    // after the run since.
    t.fake.hashes.get(`chat:run:${t.job.runId}:meta`)!.updatedAt = String(Date.now() - 120_000);

    const { response, settled } = await t.request("resume");
    const sse = await response!.text();
    expect(types(sse).at(-1)).toBe("finish");
    expect(sse.endsWith("data: [DONE]\n\n")).toBe(true);
    await settled();
  });

  it("answers a poll for an abandoned run with 'still running', and continues it", async () => {
    const t = await setup();
    // Its invocation died before writing anything, long enough ago that the
    // run would be reported as stale.
    t.fake.hashes.get(`chat:run:${t.job.runId}:meta`)!.updatedAt = String(Date.now() - 120_000);
    let finishResearch!: () => void;
    const researching = new Promise<void>((resolve) => {
      finishResearch = resolve;
    });
    t.hooks.onResearch = () => researching;

    // Taken on before it is reported, so not as a stale partial (or as empty).
    const poll = await t.request("poll");
    expect(poll.response?.status).toBe(202);
    // The poll's invocation carries on with the turn after answering.
    finishResearch();
    await poll.settled();

    const later = await t.request("poll");
    expect(later.response?.status).toBe(200);
    const sse = await later.response!.text();
    expect(types(sse).at(-1)).toBe("finish");
    expect(later.response?.headers.get("x-chat-stream-stale")).toBeNull();
  });

  it("keeps a parked run alive for polls until its next attempt is overdue", async () => {
    const t = await setup({ busy: true });
    expect(await t.step()).toBe("handed-over");
    const realNow = Date.now();
    const meta = t.fake.hashes.get(`chat:run:${t.job.runId}:meta`)!;

    // Last write was long ago, but the next attempt is not due yet: still in progress.
    meta.updatedAt = String(realNow - 120_000);
    meta.wakeAt = String(realNow + 30_000);
    const waiting = await resumeChatStream(CHAT, undefined, { onlyDone: true }, t.db);
    expect(waiting?.status).toBe(202);

    // No request came to continue it: report what there is as a stale partial.
    meta.wakeAt = String(realNow - 120_000);
    const stale = await resumeChatStream(CHAT, undefined, { onlyDone: true }, t.db);
    expect(stale?.headers.get("x-chat-stream-stale")).toBe("1");
  });
});
