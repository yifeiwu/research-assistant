import { describe, expect, it } from "vitest";
import {
  createResilientGroqFetch,
  isModelRetiredResponse,
  parseGroqDurationMs,
  parseGroqRateLimitResponse,
  rewriteGroqRequestBody,
  type GroqCooldownDb,
} from "@/lib/agent/groq-rate-limit";
import { FakeRedis } from "./fake-redis";

const asDb = (fake: FakeRedis) => fake as unknown as GroqCooldownDb;

function jsonOk(model: string): Response {
  return new Response(
    JSON.stringify({ id: "cmpl_1", model, choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function jsonError(status: number, message: string, code?: string): Response {
  return new Response(
    JSON.stringify({
      error: {
        message,
        type: "invalid_request_error",
        ...(code ? { code } : {}),
      },
    }),
    { status, headers: { "content-type": "application/json" } },
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

describe("parseGroqDurationMs, parseGroqRateLimitResponse & isModelRetiredResponse", () => {
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

  it("distinguishes model retirement / 404 / decommission errors from generic 400 validation errors", () => {
    expect(isModelRetiredResponse(404, '{"error":{"message":"The model `foo` does not exist"}}')).toBe(true);
    expect(
      isModelRetiredResponse(
        400,
        '{"error":{"message":"The model `qwen/qwen3.6-27b` has been decommissioned and is no longer supported.","code":"model_decommissioned"}}',
      ),
    ).toBe(true);
    expect(
      isModelRetiredResponse(
        403,
        '{"error":{"message":"Organization does not have access to model `llama-3.3-70b-versatile`","code":"model_permission_blocked"}}',
      ),
    ).toBe(true);
    expect(
      isModelRetiredResponse(400, '{"error":{"message":"messages[0].content must be a string"}}'),
    ).toBe(false);
  });
});

describe("rewriteGroqRequestBody", () => {
  it("converts deprecated max_tokens to max_completion_tokens and normalizes reasoning fields across GPT-OSS, Qwen, and ALLaM", () => {
    const gptSynthesis = JSON.stringify({
      model: "openai/gpt-oss-120b",
      max_tokens: 4_000,
      reasoning_effort: "medium",
      messages: [{ role: "user", content: "hi" }],
    });
    const normalizedGpt = JSON.parse(
      rewriteGroqRequestBody(gptSynthesis, "openai/gpt-oss-120b", "synthesis", 4_000),
    );
    expect(normalizedGpt.max_tokens).toBeUndefined();
    expect(normalizedGpt.max_completion_tokens).toBe(4_000);
    expect(normalizedGpt.reasoning_effort).toBe("medium");
    expect(normalizedGpt.reasoning_format).toBeUndefined();

    const toQwen = JSON.parse(
      rewriteGroqRequestBody(gptSynthesis, "qwen/qwen3.8-27b", "synthesis", 4_000),
    );
    expect(toQwen.model).toBe("qwen/qwen3.8-27b");
    expect(toQwen.max_tokens).toBeUndefined();
    expect(toQwen.max_completion_tokens).toBe(900);
    expect(toQwen.reasoning_effort).toBe("none");
    expect(toQwen.reasoning_format).toBe("hidden");

    const toAllam = JSON.parse(
      rewriteGroqRequestBody(gptSynthesis, "allam-2-7b", "synthesis", 4_000),
    );
    expect(toAllam.model).toBe("allam-2-7b");
    expect(toAllam.max_completion_tokens).toBe(900);
    expect(toAllam.reasoning_format).toBeUndefined();
    expect(toAllam.reasoning_effort).toBeUndefined();

    const backToGpt = JSON.parse(
      rewriteGroqRequestBody(JSON.stringify(toQwen), "openai/gpt-oss-20b", "synthesis", 4_000),
    );
    expect(backToGpt.model).toBe("openai/gpt-oss-20b");
    expect(backToGpt.max_completion_tokens).toBe(4_000);

    // Multi-turn failover from Qwen (900) to GPT-OSS with ~5,000 input tokens clamps below 8,000 TPM!
    const heavyQwen = JSON.stringify({
      model: "qwen/qwen3.8-27b",
      max_completion_tokens: 900,
      messages: [{ role: "system", content: "x".repeat(20_000) }],
    });
    const clampedGpt = JSON.parse(
      rewriteGroqRequestBody(heavyQwen, "openai/gpt-oss-120b", "synthesis", 4_000),
    );
    expect(clampedGpt.max_completion_tokens).toBeLessThanOrEqual(2_500);
    expect(clampedGpt.max_completion_tokens).toBeGreaterThanOrEqual(256);
  });

  it("rewrites auxiliary reasoning fields and trims summary source excerpts when switching onto 4k-context allam-2-7b", () => {
    const gptSummary = JSON.stringify({
      model: "openai/gpt-oss-20b",
      max_tokens: 650,
      reasoning_effort: "low",
      messages: [
        {
          role: "user",
          content: [
            "Research question:\ntest",
            `<source 1>\nTitle: A\nURL: https://a.com\nContent:\n"""\n${"a".repeat(4_500)}\n"""\n</source 1>`,
            `<source 2>\nTitle: B\nURL: https://b.com\nContent:\n"""\n${"b".repeat(4_500)}\n"""\n</source 2>`,
          ].join("\n\n"),
        },
      ],
    });
    const toAllam = JSON.parse(
      rewriteGroqRequestBody(gptSummary, "allam-2-7b", "summary"),
    );
    expect(toAllam.model).toBe("allam-2-7b");
    expect(toAllam.reasoning_effort).toBeUndefined();
    expect(toAllam.reasoning_format).toBeUndefined();
    expect(toAllam.max_tokens).toBeUndefined();
    expect(toAllam.max_completion_tokens).toBe(450);
    expect(String(toAllam.messages[0].content).length).toBeLessThan(6_200);
    expect(String(toAllam.messages[0].content)).toContain("<source 1>");
    expect(String(toAllam.messages[0].content)).toContain("<source 2>");
  });
});

describe("createResilientGroqFetch", () => {
  it("switches immediately to a healthy pool peer on 429 without sleeping, and skips cooled peers next call", async () => {
    const fake = new FakeRedis();
    const now = 2_000_000;
    const sleeps: number[] = [];
    const seenBodies: Record<string, unknown>[] = [];

    const makeFetch = () =>
      createResilientGroqFetch({
        stage: "synthesis",
        primaryModel: "openai/gpt-oss-120b",
        fallbackModels: ["qwen/qwen3.8-27b"],
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
              retryAfter: "6",
              bodyMessage: "Rate limit reached for model `openai/gpt-oss-120b`: Please try again in 6s.",
            });
          }
          return jsonOk(String(body.model));
        },
      });

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
    expect(seenBodies[0].max_completion_tokens).toBe(3_500);
    expect(seenBodies[1].max_completion_tokens).toBe(900);

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

  it("quarantines retired/decommissioned models (400 model_decommissioned / 404) in Redis for 24h and fails over seamlessly", async () => {
    const fake = new FakeRedis();
    const now = 5_000_000;
    const seenModels: string[] = [];

    const makeFetch = () =>
      createResilientGroqFetch({
        stage: "summary",
        primaryModel: "allam-2-7b",
        fallbackModels: ["openai/gpt-oss-20b", "qwen/qwen3.8-27b"],
        db: asDb(fake),
        now: () => now,
        baseFetch: async (_url, init) => {
          const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
          seenModels.push(String(body.model));
          if (body.model === "allam-2-7b") {
            return jsonError(
              400,
              "The model `allam-2-7b` has been decommissioned and is no longer supported.",
              "model_decommissioned",
            );
          }
          if (body.model === "openai/gpt-oss-20b") {
            return jsonError(404, "The model `openai/gpt-oss-20b` does not exist");
          }
          return jsonOk(String(body.model));
        },
      });

    // First call hits retired allam-2-7b -> 404 gpt-oss-20b -> succeeds on cross-pool qwen3.8-27b!
    const res1 = await makeFetch()("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "allam-2-7b", max_tokens: 450, messages: [] }),
    });
    expect(res1.status).toBe(200);
    expect(seenModels).toEqual([
      "allam-2-7b",
      "openai/gpt-oss-20b",
      "qwen/qwen3.8-27b",
    ]);
    expect(fake.strings.get("ratelimit:groq:cooldown:allam-2-7b")).toMatch(/^retired:/);
    expect(fake.strings.get("ratelimit:groq:cooldown:openai/gpt-oss-20b")).toMatch(/^retired:/);

    // Second call skips both retired models immediately with zero wasted requests!
    seenModels.length = 0;
    const res2 = await makeFetch()("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "allam-2-7b", max_tokens: 450, messages: [] }),
    });
    expect(res2.status).toBe(200);
    expect(seenModels).toEqual(["qwen/qwen3.8-27b"]);
  });

  it("switches to a larger-context peer on HTTP 413 / context_length_exceeded without retiring the smaller model", async () => {
    const fake = new FakeRedis();
    const seenModels: string[] = [];

    const wrapped = createResilientGroqFetch({
      stage: "summary",
      primaryModel: "allam-2-7b",
      fallbackModels: ["openai/gpt-oss-20b"],
      db: asDb(fake),
      baseFetch: async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        seenModels.push(String(body.model));
        if (body.model === "allam-2-7b") {
          return jsonError(413, "Request too large for model `allam-2-7b`: context_length_exceeded");
        }
        return jsonOk(String(body.model));
      },
    });

    const res = await wrapped("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "allam-2-7b", max_tokens: 450, messages: [] }),
    });
    expect(res.status).toBe(200);
    expect(seenModels).toEqual(["allam-2-7b", "openai/gpt-oss-20b"]);
    // Not retired in Redis so normal-sized batches can still use it.
    expect(fake.strings.has("ratelimit:groq:cooldown:allam-2-7b")).toBe(false);
  });

  it("sleeps for the soonest cooldown <= maxWaitMs when every candidate is cooling down", async () => {
    const fake = new FakeRedis();
    let now = 1_000_000;
    const sleeps: number[] = [];
    const seenModels: string[] = [];
    let call = 0;

    const wrapped = createResilientGroqFetch({
      stage: "synthesis",
      primaryModel: "openai/gpt-oss-120b",
      fallbackModels: ["qwen/qwen3.8-27b"],
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
        if (call === 1) return json429({ retryAfter: "8" });
        if (call === 2) return json429({ retryAfter: "4" });
        return jsonOk(body.model);
      },
    });

    const res = await wrapped("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "openai/gpt-oss-120b", max_tokens: 3_500, messages: [] }),
    });
    expect(res.status).toBe(200);
    expect(seenModels).toEqual([
      "openai/gpt-oss-120b",
      "qwen/qwen3.8-27b",
      "qwen/qwen3.8-27b",
    ]);
    expect(sleeps).toEqual([4_150]);
  });

  it("aborts promptly during a Retry-After sleep when the caller cancels", async () => {
    const controller = new AbortController();
    const wrapped = createResilientGroqFetch({
      stage: "synthesis",
      primaryModel: "openai/gpt-oss-120b",
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

  it("does not sleep on daily RPD exhaustion even when retry-after is short", async () => {
    const sleeps: number[] = [];
    const seenModels: string[] = [];
    const wrapped = createResilientGroqFetch({
      stage: "synthesis",
      primaryModel: "openai/gpt-oss-120b",
      db: null,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      baseFetch: async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        seenModels.push(body.model);
        return json429({
          retryAfter: "2",
          remainingRequests: "0",
          bodyMessage: "Rate limit reached on requests per day (RPD).",
        });
      },
    });

    const res = await wrapped("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "openai/gpt-oss-120b", max_tokens: 3_500, messages: [] }),
    });
    expect(res.status).toBe(429);
    expect(sleeps).toHaveLength(0);
    expect(seenModels).toEqual(["openai/gpt-oss-120b"]);
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
