import { describe, expect, it } from "vitest";
import {
  createResilientGroqFetch,
  parseGroqDurationMs,
  parseGroqRateLimitResponse,
  rewriteGroqRequestBody,
  type GroqCooldownDb,
  type GroqFallbackEvent,
} from "@/lib/agent/groq-rate-limit";
import { FakeRedis } from "./fake-redis";

const asDb = (fake: FakeRedis) => fake as unknown as GroqCooldownDb;

function jsonOk(model: string): Response {
  return new Response(
    JSON.stringify({ id: "cmpl_1", model, choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function json429(opts: {
  retryAfter?: string;
  resetTokens?: string;
  remainingRequests?: string;
  bodyMessage?: string;
}): Response {
  const headers = new Headers({ "content-type": "application/json" });
  if (opts.retryAfter) headers.set("retry-after", opts.retryAfter);
  if (opts.resetTokens) headers.set("x-ratelimit-reset-tokens", opts.resetTokens);
  if (opts.remainingRequests) headers.set("x-ratelimit-remaining-requests", opts.remainingRequests);
  return new Response(
    JSON.stringify({
      error: {
        message: opts.bodyMessage ?? "Rate limit reached.",
        type: "tokens",
      },
    }),
    { status: 429, headers },
  );
}

describe("parseGroqDurationMs & parseGroqRateLimitResponse", () => {
  it("parses plain seconds and compound Groq reset durations", () => {
    expect(parseGroqDurationMs("8")).toBe(8_000);
    expect(parseGroqDurationMs("7.66s")).toBe(7_660);
    expect(parseGroqDurationMs("2m59.56s")).toBe(179_560);
    expect(parseGroqDurationMs("450ms")).toBe(450);
  });

  it("detects daily RPD exhaustion from body or remaining-requests header", () => {
    const fromBody = parseGroqRateLimitResponse(
      new Headers(),
      "Rate limit reached on requests per day (RPD): Limit 1000. Please try again in 15m0s.",
    );
    expect(fromBody.daily).toBe(true);
    expect(fromBody.waitMs).toBe(900_000);

    const fromHeader = parseGroqRateLimitResponse(
      new Headers({ "x-ratelimit-remaining-requests": "0", "retry-after": "4" }),
      "Rate limit reached",
    );
    expect(fromHeader.daily).toBe(true);
  });
});

describe("rewriteGroqRequestBody", () => {
  it("normalizes reasoning fields and caps max_tokens when switching between GPT-OSS and Qwen", () => {
    const gptSynthesis = JSON.stringify({
      model: "openai/gpt-oss-120b",
      max_tokens: 3_500,
      reasoning_format: "parsed",
      messages: [{ role: "user", content: "hi" }],
    });
    const toQwen = JSON.parse(
      rewriteGroqRequestBody(gptSynthesis, "qwen/qwen3.8-27b", "synthesis", 3_500),
    );
    expect(toQwen.model).toBe("qwen/qwen3.8-27b");
    expect(toQwen.max_tokens).toBe(900);
    expect(toQwen.reasoning_format).toBe("parsed");
    expect(toQwen.reasoning_effort).toBeUndefined();

    // Switching the other way (Qwen -> GPT-OSS) lifts max_tokens back to 3,500.
    const backToGpt = JSON.parse(
      rewriteGroqRequestBody(JSON.stringify(toQwen), "openai/gpt-oss-20b", "synthesis", 3_500),
    );
    expect(backToGpt.model).toBe("openai/gpt-oss-20b");
    expect(backToGpt.max_tokens).toBe(3_500);
  });

  it("rewrites auxiliary reasoning_effort between Qwen 'none' and GPT-OSS 'low'", () => {
    const qwenSummary = JSON.stringify({
      model: "qwen/qwen3.8-27b",
      max_tokens: 350,
      reasoning_effort: "none",
      reasoning_format: "hidden",
      messages: [],
    });
    const toGptAux = JSON.parse(
      rewriteGroqRequestBody(qwenSummary, "openai/gpt-oss-20b", "summary"),
    );
    expect(toGptAux.model).toBe("openai/gpt-oss-20b");
    expect(toGptAux.reasoning_effort).toBe("low");
    expect(toGptAux.reasoning_format).toBe("parsed");
    expect(toGptAux.max_tokens).toBe(350);
  });
});

describe("createResilientGroqFetch", () => {
  it("sleeps for Retry-After <= 10s on synthesis and retries selectedModel once without switching", async () => {
    const fake = new FakeRedis();
    let now = 1_000_000;
    const sleeps: number[] = [];
    const seenModels: string[] = [];
    const fallbacks: GroqFallbackEvent[] = [];
    let call = 0;

    const wrapped = createResilientGroqFetch({
      stage: "synthesis",
      primaryModel: "openai/gpt-oss-120b",
      fallbackModels: ["openai/gpt-oss-20b", "qwen/qwen3.8-27b"],
      onFallback: (e) => fallbacks.push(e),
      db: asDb(fake),
      now: () => now,
      sleep: async (ms) => {
        sleeps.push(ms);
        now += ms;
      },
      baseFetch: async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        seenModels.push(body.model);
        call += 1;
        if (call === 1) {
          return json429({ retryAfter: "6" });
        }
        return jsonOk(body.model);
      },
    });

    const res = await wrapped("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "openai/gpt-oss-120b", max_tokens: 3_500, messages: [] }),
    });
    expect(res.status).toBe(200);
    expect(seenModels).toEqual(["openai/gpt-oss-120b", "openai/gpt-oss-120b"]);
    expect(sleeps).toEqual([6_200]);
    expect(fallbacks).toHaveLength(0);
  });

  it("aborts promptly during a Retry-After sleep when the caller cancels", async () => {
    const controller = new AbortController();
    const wrapped = createResilientGroqFetch({
      stage: "synthesis",
      primaryModel: "openai/gpt-oss-120b",
      fallbackModels: ["openai/gpt-oss-20b"],
      db: null,
      sleep: () => new Promise(() => {}),
      baseFetch: async () => {
        setTimeout(() => controller.abort(), 5);
        return json429({ retryAfter: "5" });
      },
    });

    await expect(
      wrapped("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        signal: controller.signal,
        body: JSON.stringify({ model: "openai/gpt-oss-120b", max_tokens: 3_500, messages: [] }),
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("falls back immediately without sleeping on long Retry-After (> 10s) or daily RPD limit, and persists cooldown in Redis", async () => {
    const fake = new FakeRedis();
    const now = 2_000_000;
    const sleeps: number[] = [];
    const seenBodies: Record<string, unknown>[] = [];
    const fallbacks: GroqFallbackEvent[] = [];

    const makeFetch = () =>
      createResilientGroqFetch({
        stage: "synthesis",
        primaryModel: "openai/gpt-oss-120b",
        fallbackModels: ["qwen/qwen3.8-27b"],
        onFallback: (e) => fallbacks.push(e),
        db: asDb(fake),
        now: () => now,
        sleep: async (ms) => {
          sleeps.push(ms);
        },
        baseFetch: async (_url, init) => {
          const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
          seenBodies.push(body);
          if (body.model === "openai/gpt-oss-120b") {
            return json429({
              retryAfter: "25",
              bodyMessage: "Rate limit reached for model `openai/gpt-oss-120b`: Please try again in 25s.",
            });
          }
          return jsonOk(String(body.model));
        },
      });

    // First request hits 429 on 120B (25s > 10s), switches immediately to Qwen with capped max_tokens.
    const res1 = await makeFetch()("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({
        model: "openai/gpt-oss-120b",
        max_tokens: 3_500,
        reasoning_format: "parsed",
        messages: [],
      }),
    });
    expect(res1.status).toBe(200);
    expect(sleeps).toHaveLength(0);
    expect(seenBodies.map((b) => b.model)).toEqual([
      "openai/gpt-oss-120b",
      "qwen/qwen3.8-27b",
    ]);
    expect(seenBodies[1].max_tokens).toBe(900);
    expect(fallbacks).toEqual([
      { from: "openai/gpt-oss-120b", to: "qwen/qwen3.8-27b", retryAfterMs: 25_000 },
    ]);

    // Second request sees Redis cooldown on 120B (> 10s remaining) and skips 120B with zero wasted 429s!
    seenBodies.length = 0;
    const res2 = await makeFetch()("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({
        model: "openai/gpt-oss-120b",
        max_tokens: 3_500,
        messages: [],
      }),
    });
    expect(res2.status).toBe(200);
    expect(seenBodies.map((b) => b.model)).toEqual(["qwen/qwen3.8-27b"]);
  });

  it("switches immediately on daily RPD exhaustion even when retry-after is short", async () => {
    const sleeps: number[] = [];
    const seenModels: string[] = [];
    const wrapped = createResilientGroqFetch({
      stage: "synthesis",
      primaryModel: "openai/gpt-oss-120b",
      fallbackModels: ["openai/gpt-oss-20b"],
      db: null,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      baseFetch: async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        seenModels.push(body.model);
        if (body.model === "openai/gpt-oss-120b") {
          return json429({
            retryAfter: "2",
            remainingRequests: "0",
            bodyMessage: "Rate limit reached on requests per day (RPD).",
          });
        }
        return jsonOk(body.model);
      },
    });

    const res = await wrapped("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "openai/gpt-oss-120b", max_tokens: 3_500, messages: [] }),
    });
    expect(res.status).toBe(200);
    expect(sleeps).toHaveLength(0);
    expect(seenModels).toEqual(["openai/gpt-oss-120b", "openai/gpt-oss-20b"]);
  });

  it("fails open when Redis cooldown store throws", async () => {
    const brokenDb: GroqCooldownDb = {
      set: async () => {
        throw new Error("redis write down");
      },
      pipeline: () => ({
        get: () => undefined,
        exec: async () => {
          throw new Error("redis read down");
        },
      }),
    };

    const wrapped = createResilientGroqFetch({
      stage: "planner",
      primaryModel: "openai/gpt-oss-20b",
      fallbackModels: ["qwen/qwen3.8-27b"],
      db: brokenDb,
      baseFetch: async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        if (body.model === "openai/gpt-oss-20b") {
          return json429({ retryAfter: "15" });
        }
        return jsonOk(body.model);
      },
    });

    const res = await wrapped("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({
        model: "openai/gpt-oss-20b",
        reasoning_effort: "low",
        reasoning_format: "parsed",
        messages: [],
      }),
    });
    expect(res.status).toBe(200);
  });
});
