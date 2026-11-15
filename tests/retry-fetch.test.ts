import { describe, expect, it } from "vitest";
import { fetchWithRetryAfter } from "@/lib/retry-fetch";

const tooMany = (retryAfter?: string) =>
  new Response(JSON.stringify({ error: "slow down" }), {
    status: 429,
    headers: retryAfter === undefined ? {} : { "Retry-After": retryAfter },
  });

function setup(responses: Response[]) {
  const calls: Array<{ input: unknown; init?: RequestInit }> = [];
  const delays: number[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ input, init });
    return responses.shift()!;
  }) as typeof fetch;
  const run = (init: RequestInit = { method: "POST", body: "{}" }) =>
    fetchWithRetryAfter(fetchImpl, "/api/chat", init, {
      delay: async (ms) => {
        delays.push(ms);
      },
    });
  return { calls, delays, run };
}

describe("fetchWithRetryAfter", () => {
  it("waits out a short Retry-After and sends the same request again", async () => {
    const ok = new Response("ok");
    const { run, calls, delays } = setup([tooMany("3"), ok]);
    const init = { method: "POST", body: '{"messages":[]}' };
    expect(await run(init)).toBe(ok);
    expect(delays).toEqual([3_000]);
    expect(calls).toHaveLength(2);
    expect(calls[1].init).toBe(init);
  });

  it("retries only once", async () => {
    const second = tooMany("2");
    const { run, calls } = setup([tooMany("2"), second]);
    expect(await run()).toBe(second);
    expect(calls).toHaveLength(2);
  });

  it("returns the 429 when the wait is long, missing, or not a delay", async () => {
    for (const header of ["45", undefined, "Wed, 21 Oct 2026 07:28:00 GMT"]) {
      const first = tooMany(header);
      const { run, calls, delays } = setup([first]);
      expect(await run()).toBe(first);
      expect(calls).toHaveLength(1);
      expect(delays).toEqual([]);
    }
  });

  it("does not retry other failures", async () => {
    const failure = new Response("boom", { status: 500, headers: { "Retry-After": "1" } });
    const { run, calls } = setup([failure]);
    expect(await run()).toBe(failure);
    expect(calls).toHaveLength(1);
  });

  it("does not replay a body that cannot be re-sent", async () => {
    const first = tooMany("1");
    const { run, calls } = setup([first]);
    const body = new ReadableStream();
    expect(await run({ method: "POST", body })).toBe(first);
    expect(calls).toHaveLength(1);
  });

  it("rejects without retrying if the request is aborted during the wait", async () => {
    const calls: unknown[] = [];
    const controller = new AbortController();
    const fetchImpl = (async () => {
      calls.push(1);
      // The user presses Stop while the client is waiting to retry.
      queueMicrotask(() => controller.abort());
      return tooMany("5");
    }) as typeof fetch;

    await expect(
      fetchWithRetryAfter(fetchImpl, "/api/chat", {
        method: "POST",
        body: "{}",
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(calls).toHaveLength(1);
  });
});