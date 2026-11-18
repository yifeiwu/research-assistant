import { describe, expect, it } from "vitest";
import { createGroqBudget } from "@/lib/agent/groq-budget";
import {
  isResolutionError,
  planModels,
  resolveModels,
  type ResolvedModels,
} from "@/lib/agent/models";
import type { GroqCooldownDb } from "@/lib/agent/groq-rate-limit";
import {
  REASONING_POOL,
  SUMMARIZER_POOL,
  groqReasoningOptions,
  maxSummaryBatchInputChars,
  maxSummaryOutputTokens,
  maxSynthesisOutputTokens,
} from "@/lib/models";
import { FakeRedis } from "./fake-redis";

describe("model pools and stage routing", () => {
  it("keeps full-OTPM GPT-OSS models in the reasoning pool and 1k-OTPM Qwen + ALLaM in the summarizer pool", () => {
    expect(REASONING_POOL).toEqual(["openai/gpt-oss-120b", "openai/gpt-oss-20b"]);
    expect(SUMMARIZER_POOL).toEqual(["qwen/qwen3.8-27b", "allam-2-7b"]);

    const plan = planModels({ apiKey: "gsk_test" });
    if (isResolutionError(plan)) throw new Error(plan.error);
    expect(plan.pools.reasoning).toEqual(REASONING_POOL);
    expect(plan.pools.summarizer).toEqual(SUMMARIZER_POOL);
  });

  it("round-robins fungibly across both the summarizer pool and the reasoning pool", async () => {
    const resolved = resolveModels({
      apiKey: "gsk_test",
      db: null,
      budget: createGroqBudget({ db: null }),
    });
    if (isResolutionError(resolved)) throw new Error(resolved.error);

    const leaseModel = (stage: { run: ResolvedModels["stages"]["summary"]["run"] }) =>
      stage.run({ execute: async (l) => ({ value: l.modelId }) });

    const sum1 = await leaseModel(resolved.stages.summary);
    const sum2 = await leaseModel(resolved.stages.summary);
    expect([sum1.modelId, sum2.modelId]).toEqual([
      "qwen/qwen3.8-27b",
      "allam-2-7b",
    ]);

    const synth1 = await leaseModel(resolved.stages.synthesis);
    const synth2 = await leaseModel(resolved.stages.synthesis);
    expect([synth1.modelId, synth2.modelId]).toEqual([
      "openai/gpt-oss-120b",
      "openai/gpt-oss-20b",
    ]);
  });

  it("skips cooled/retired peers and spills over across pools when an entire primary pool is retired", async () => {
    const fake = new FakeRedis();
    const farFuture = Date.now() + 86_400_000;
    for (const id of SUMMARIZER_POOL) {
      fake.strings.set(`ratelimit:groq:cooldown:${id}`, `retired:${farFuture}`);
    }

    const resolved = resolveModels({
      apiKey: "gsk_test",
      db: fake as unknown as GroqCooldownDb,
      budget: createGroqBudget({ db: null }),
    });
    if (isResolutionError(resolved)) throw new Error(resolved.error);

    const summaryLease = await resolved.stages.summary.run({
      execute: async (l) => ({ value: l.modelId }),
    });
    expect(REASONING_POOL).toContain(summaryLease.modelId);
  });

  it("rejects empty pools with a 500 resolution error", () => {
    const bad = planModels({
      apiKey: "gsk_test",
      pools: { reasoning: [], summarizer: ["qwen/qwen3.8-27b"] },
    });
    expect(isResolutionError(bad)).toBe(true);
  });
});

describe("per-model reasoning options and context/OTPM caps", () => {
  it("preserves 4,000 synthesis output tokens on GPT-OSS while capping Qwen and ALLaM at 900", () => {
    expect(maxSynthesisOutputTokens("openai/gpt-oss-120b", 4_000)).toBe(4_000);
    expect(maxSynthesisOutputTokens("openai/gpt-oss-20b", 4_000)).toBe(4_000);
    expect(maxSynthesisOutputTokens("qwen/qwen3.8-27b", 4_000)).toBe(900);
    expect(maxSynthesisOutputTokens("allam-2-7b", 4_000)).toBe(900);

    expect(maxSummaryOutputTokens("qwen/qwen3.8-27b", 1_000)).toBe(850);
    expect(maxSummaryOutputTokens("allam-2-7b", 1_000)).toBe(850);
    expect(maxSummaryOutputTokens("openai/gpt-oss-20b", 1_000)).toBe(1_000);

    expect(maxSummaryBatchInputChars("allam-2-7b", 10_000)).toBe(6_000);
    expect(maxSummaryBatchInputChars("openai/gpt-oss-20b", 10_000)).toBe(10_000);
  });

  it("disables thinking on Qwen synthesis fallbacks so 900 OTPM goes 100% to answer text, and omits unsupported reasoningFormat on GPT-OSS", () => {
    expect(groqReasoningOptions("allam-2-7b", "auxiliary")).toBeUndefined();
    expect(groqReasoningOptions("allam-2-7b", "synthesis", "high")).toBeUndefined();
    expect(groqReasoningOptions("qwen/qwen3.8-27b", "auxiliary")).toEqual({
      groq: { reasoningEffort: "none", reasoningFormat: "hidden" },
    });
    expect(groqReasoningOptions("openai/gpt-oss-20b", "auxiliary")).toEqual({
      groq: { reasoningEffort: "low" },
    });
    expect(groqReasoningOptions("qwen/qwen3.8-27b", "synthesis", "high")).toEqual({
      groq: { reasoningEffort: "none", reasoningFormat: "hidden" },
    });
    expect(groqReasoningOptions("openai/gpt-oss-120b", "synthesis", "high")).toEqual({
      groq: { reasoningEffort: "medium" },
    });
    expect(groqReasoningOptions("openai/gpt-oss-120b", "synthesis", "medium")).toEqual({
      groq: { reasoningEffort: "low" },
    });
    expect(groqReasoningOptions("custom/non-reasoning", "synthesis")).toBeUndefined();
  });
});
