import { APICallError, generateText } from "ai";
import { describe, expect, it } from "vitest";
import { createGroqBudget } from "@/lib/agent/groq-budget";
import {
  isContextOverflowResponse,
  isModelRetiredResponse,
  normalizeGroqCompletionBody,
  parseGroqDurationMs,
  parseGroqRateLimitResponse,
  type GroqCooldownDb,
} from "@/lib/agent/groq-rate-limit";
import { isResolutionError, resolveModels } from "@/lib/agent/models";
import { generateAuxiliaryText } from "@/lib/agent/stage";
import {
  fitSynthesisOutputTokens,
  groqReasoningOptions,
  maxSummaryBatchInputChars,
  maxSummaryOutputTokens,
} from "@/lib/models";
import { FakeRedis } from "./fake-redis";

const asDb = (fake: FakeRedis) => fake as unknown as GroqCooldownDb;

function jsonOk(model: string): Response {
  return new Response(
    JSON.stringify({
      id: "cmpl_1",
      created: 1_700_000_000,
      model,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "ok" },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 },
    }),
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

describe("parseGroqDurationMs, parseGroqRateLimitResponse & error classifiers", () => {
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
      { "x-ratelimit-remaining-requests": "0", "retry-after": "4" },
      "Rate limit reached",
    );
    expect(fromHeader.daily).toBe(true);
  });

  it("distinguishes model retirement / 404 / decommission errors and 413 context overflows from generic 400 validation errors", () => {
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

    expect(isContextOverflowResponse(413, "Request too large")).toBe(true);
    expect(isContextOverflowResponse(400, "context_length_exceeded")).toBe(true);
    expect(isContextOverflowResponse(400, "invalid parameter")).toBe(false);
  });

  it("normalizes deprecated max_tokens to max_completion_tokens without touching model or messages", () => {
    const normalized = JSON.parse(
      normalizeGroqCompletionBody(
        JSON.stringify({
          model: "openai/gpt-oss-120b",
          max_tokens: 4_000,
          reasoning_effort: "medium",
          messages: [{ role: "user", content: "hi" }],
        }),
      ),
    );
    expect(normalized.max_tokens).toBeUndefined();
    expect(normalized.max_completion_tokens).toBe(4_000);
    expect(normalized.model).toBe("openai/gpt-oss-120b");
    expect(normalized.reasoning_effort).toBe("medium");
  });
});

describe("StageRunner unified failover & rate-limit resilience", () => {
  it("switches immediately to a healthy pool peer on 429 with native per-model prompts/caps, and skips cooled peers next call", async () => {
    const fake = new FakeRedis();
    const now = 2_000_000;
    const sleeps: number[] = [];
    const seenBodies: Record<string, unknown>[] = [];

    const makeResolved = () => {
      const r = resolveModels({
        apiKey: "gsk_test",
        pools: {
          reasoning: ["openai/gpt-oss-120b"],
          summarizer: ["qwen/qwen3.8-27b"],
        },
        preferPoolWaitMs: { synthesis: 0 },
        db: asDb(fake),
        budget: createGroqBudget({ db: null }),
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
      if (isResolutionError(r)) throw new Error(r.error);
      return r;
    };

    const runSynthesis = (resolved: ReturnType<typeof makeResolved>) =>
      resolved.stages.synthesis.run({
        execute: async (leased, attemptSignal) => {
          const res = await generateText({
            model: leased.model,
            prompt: "Explain Rust",
            maxOutputTokens: fitSynthesisOutputTokens(leased.modelId, 200, 3_500),
            providerOptions: groqReasoningOptions(leased.modelId, "synthesis", "high"),
            abortSignal: attemptSignal,
            maxRetries: 0,
          });
          return { value: res.text, headers: res.response.headers };
        },
      });

    const out1 = await runSynthesis(makeResolved());
    expect(out1.value).toBe("ok");
    expect(out1.modelId).toBe("qwen/qwen3.8-27b");
    expect(sleeps).toHaveLength(0);
    expect(seenBodies.map((b) => b.model)).toEqual([
      "openai/gpt-oss-120b",
      "qwen/qwen3.8-27b",
    ]);
    // Native per-model caps and reasoning options without JSON rewriting!
    expect(seenBodies[0].max_tokens).toBeUndefined();
    expect(seenBodies[0].max_completion_tokens).toBe(3_500);
    expect(seenBodies[0].reasoning_effort).toBe("medium");
    expect(seenBodies[1].max_completion_tokens).toBe(900);
    expect(seenBodies[1].reasoning_effort).toBe("none");
    expect(seenBodies[1].reasoning_format).toBe("hidden");

    // Second call skips cooled openai/gpt-oss-120b immediately!
    seenBodies.length = 0;
    const out2 = await runSynthesis(makeResolved());
    expect(out2.modelId).toBe("qwen/qwen3.8-27b");
    expect(seenBodies.map((b) => b.model)).toEqual(["qwen/qwen3.8-27b"]);
  });

  it("quarantines retired/decommissioned models (400 model_decommissioned / 404) in Redis for 24h and fails over seamlessly", async () => {
    const fake = new FakeRedis();
    const now = 5_000_000;
    const seenModels: string[] = [];

    const makeResolved = () => {
      const r = resolveModels({
        apiKey: "gsk_test",
        pools: {
          summarizer: ["allam-2-7b", "qwen/qwen3.8-27b"],
          reasoning: ["openai/gpt-oss-20b"],
        },
        db: asDb(fake),
        budget: createGroqBudget({ db: null }),
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
          if (body.model === "qwen/qwen3.8-27b") {
            return jsonError(404, "The model `qwen/qwen3.8-27b` does not exist");
          }
          return jsonOk(String(body.model));
        },
      });
      if (isResolutionError(r)) throw new Error(r.error);
      return r;
    };

    const text1 = await generateAuxiliaryText({
      stage: makeResolved().stages.summary,
      system: "Summarize",
      prompt: (modelId) => "x".repeat(maxSummaryBatchInputChars(modelId, 9_000)),
      maxOutputTokens: (modelId) => maxSummaryOutputTokens(modelId, 1_000),
      timeoutMs: 10_000,
    });
    expect(text1).toBe("ok");
    expect(seenModels).toEqual([
      "allam-2-7b",
      "qwen/qwen3.8-27b",
      "openai/gpt-oss-20b",
    ]);
    expect(fake.strings.get("ratelimit:groq:cooldown:allam-2-7b")).toMatch(/^retired:/);
    expect(fake.strings.get("ratelimit:groq:cooldown:qwen/qwen3.8-27b")).toMatch(/^retired:/);

    // Second call skips both retired models immediately with zero wasted requests!
    seenModels.length = 0;
    const text2 = await generateAuxiliaryText({
      stage: makeResolved().stages.summary,
      system: "Summarize",
      prompt: "short",
      maxOutputTokens: 500,
      timeoutMs: 10_000,
    });
    expect(text2).toBe("ok");
    expect(seenModels).toEqual(["openai/gpt-oss-20b"]);
  });

  it("switches to a larger-context peer on HTTP 413 / context_length_exceeded with native per-model prompt sizing", async () => {
    const fake = new FakeRedis();
    const seenPrompts: Array<{ model: string; chars: number }> = [];

    const r = resolveModels({
      apiKey: "gsk_test",
      pools: {
        summarizer: ["allam-2-7b"],
        reasoning: ["openai/gpt-oss-20b"],
      },
      db: asDb(fake),
      budget: createGroqBudget({ db: null }),
      baseFetch: async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as {
          model: string;
          messages: Array<{ role: string; content: string }>;
        };
        const userMsg = body.messages.find((m) => m.role === "user")?.content ?? "";
        seenPrompts.push({ model: body.model, chars: userMsg.length });
        if (body.model === "allam-2-7b") {
          return jsonError(413, "Request too large for model `allam-2-7b`: context_length_exceeded");
        }
        return jsonOk(body.model);
      },
    });
    if (isResolutionError(r)) throw new Error(r.error);

    const text = await generateAuxiliaryText({
      stage: r.stages.summary,
      system: "Summarize",
      prompt: (modelId) => "x".repeat(maxSummaryBatchInputChars(modelId, 9_000)),
      maxOutputTokens: 500,
      timeoutMs: 10_000,
    });
    expect(text).toBe("ok");
    expect(seenPrompts).toEqual([
      { model: "allam-2-7b", chars: 6_000 },
      { model: "openai/gpt-oss-20b", chars: 9_000 },
    ]);
    // Not retired in Redis so normal-sized batches can still use it.
    expect(fake.strings.has("ratelimit:groq:cooldown:allam-2-7b")).toBe(false);
  });

  it("sleeps for the soonest cooldown <= stageMaxWaitMs when every candidate is cooling down", async () => {
    const fake = new FakeRedis();
    let now = 1_000_000;
    const sleeps: number[] = [];
    const seenModels: string[] = [];
    let call = 0;

    const r = resolveModels({
      apiKey: "gsk_test",
      pools: {
        reasoning: ["openai/gpt-oss-120b"],
        summarizer: ["qwen/qwen3.8-27b"],
      },
      preferPoolWaitMs: { synthesis: 0 },
      db: asDb(fake),
      budget: createGroqBudget({ db: null }),
      now: () => now,
      random: () => 0,
      sleep: async (ms) => {
        sleeps.push(ms);
        now += ms;
      },
      baseFetch: async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as { model: string };
        seenModels.push(body.model);
        call += 1;
        if (call === 1) return json429({ retryAfter: "8" });
        if (call === 2) return json429({ retryAfter: "4" });
        return jsonOk(body.model);
      },
    });
    if (isResolutionError(r)) throw new Error(r.error);

    const out = await r.stages.synthesis.run({
      execute: async (leased, attemptSignal) => {
        const res = await generateText({
          model: leased.model,
          prompt: "test",
          maxOutputTokens: 500,
          abortSignal: attemptSignal,
          maxRetries: 0,
        });
        return { value: res.text, headers: res.response.headers };
      },
    });
    expect(out.value).toBe("ok");
    expect(seenModels).toEqual([
      "openai/gpt-oss-120b",
      "qwen/qwen3.8-27b",
      "qwen/qwen3.8-27b",
    ]);
    expect(sleeps).toEqual([4_080]);
  });

  it("aborts promptly during a Retry-After sleep when the caller cancels", async () => {
    const controller = new AbortController();
    const r = resolveModels({
      apiKey: "gsk_test",
      pools: {
        reasoning: ["openai/gpt-oss-120b"],
        summarizer: ["allam-2-7b"],
      },
      db: null,
      budget: createGroqBudget({ db: null }),
      sleep: () => new Promise(() => {}),
      baseFetch: async () => {
        setTimeout(() => controller.abort(), 5);
        return json429({ retryAfter: "5" });
      },
    });
    if (isResolutionError(r)) throw new Error(r.error);

    await expect(
      r.stages.synthesis.run({
        signal: controller.signal,
        execute: async (leased, attemptSignal) => {
          const res = await generateText({
            model: leased.model,
            prompt: "test",
            abortSignal: attemptSignal,
            maxRetries: 0,
          });
          return { value: res.text };
        },
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("does not sleep on daily RPD exhaustion even when retry-after is short", async () => {
    const sleeps: number[] = [];
    const seenModels: string[] = [];
    const r = resolveModels({
      apiKey: "gsk_test",
      pools: {
        reasoning: ["openai/gpt-oss-120b"],
        summarizer: ["allam-2-7b"], // excluded from synthesis fallbackPool
      },
      db: null,
      budget: createGroqBudget({ db: null }),
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      baseFetch: async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as { model: string };
        seenModels.push(body.model);
        return json429({
          retryAfter: "2",
          remainingRequests: "0",
          bodyMessage: "Rate limit reached on requests per day (RPD).",
        });
      },
    });
    if (isResolutionError(r)) throw new Error(r.error);

    await expect(
      r.stages.synthesis.run({
        execute: async (leased, attemptSignal) => {
          const res = await generateText({
            model: leased.model,
            prompt: "test",
            abortSignal: attemptSignal,
            maxRetries: 0,
          });
          return { value: res.text };
        },
      }),
    ).rejects.toSatisfy(
      (err: unknown) => APICallError.isInstance(err) && err.statusCode === 429,
    );
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

    const r = resolveModels({
      apiKey: "gsk_test",
      pools: {
        reasoning: ["openai/gpt-oss-20b"],
        summarizer: ["qwen/qwen3.8-27b"],
      },
      preferPoolWaitMs: { planner: 0 },
      db: brokenDb,
      budget: createGroqBudget({ db: null }),
      baseFetch: async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as { model: string };
        if (body.model === "openai/gpt-oss-20b") {
          return json429({ retryAfter: "15" });
        }
        return jsonOk(body.model);
      },
    });
    if (isResolutionError(r)) throw new Error(r.error);

    const text = await generateAuxiliaryText({
      stage: r.stages.planner,
      system: "Plan",
      prompt: "query",
      maxOutputTokens: 200,
      timeoutMs: 10_000,
    });
    expect(text).toBe("ok");
  });

  it("switches to a healthy peer when an individual HTTP attempt exceeds attemptTimeoutMs", async () => {
    const seenModels: string[] = [];
    const r = resolveModels({
      apiKey: "gsk_test",
      pools: {
        summarizer: ["qwen/qwen3.8-27b", "allam-2-7b"],
        reasoning: ["openai/gpt-oss-20b"],
      },
      attemptTimeoutMs: { summary: 25 },
      db: null,
      budget: createGroqBudget({ db: null }),
      baseFetch: async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as { model: string };
        seenModels.push(body.model);
        if (body.model === "qwen/qwen3.8-27b") {
          return new Promise<Response>((_, reject) => {
            init?.signal?.addEventListener(
              "abort",
              () => {
                const err = new Error("Aborted");
                err.name = "AbortError";
                reject(err);
              },
              { once: true },
            );
          });
        }
        return jsonOk(body.model);
      },
    });
    if (isResolutionError(r)) throw new Error(r.error);

    const text = await generateAuxiliaryText({
      stage: r.stages.summary,
      system: "Summarize",
      prompt: "excerpt",
      maxOutputTokens: 500,
      timeoutMs: 10_000,
    });
    expect(text).toBe("ok");
    expect(seenModels).toEqual(["qwen/qwen3.8-27b", "allam-2-7b"]);
  });
});
