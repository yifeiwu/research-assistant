import { describe, expect, it } from "vitest";
import { isResolutionError, resolveModels } from "@/lib/agent/models";
import {
  GROQ_MODELS,
  fallbackModelsFor,
  groqReasoningOptions,
  maxSummaryOutputTokens,
  maxSynthesisOutputTokens,
} from "@/lib/models";

describe("resolveModels stage separation", () => {
  it("never collides auxiliary planner or summarizer with selectedModel for any GROQ_MODELS choice", () => {
    for (const model of GROQ_MODELS) {
      const resolved = resolveModels({
        model: model.id,
        apiKey: "gsk_test",
        db: null,
      });
      expect(isResolutionError(resolved)).toBe(false);
      if (isResolutionError(resolved)) continue;

      expect(resolved.selectedModel).toBe(model.id);
      expect(resolved.stages.planner.primaryModelId).not.toBe(model.id);
      expect(resolved.stages.summary.primaryModelId).not.toBe(model.id);
    }
  });

  it("allocates all three distinct buckets on default GPT-OSS 120B", () => {
    const resolved = resolveModels({
      model: "openai/gpt-oss-120b",
      apiKey: "gsk_test",
      db: null,
    });
    if (isResolutionError(resolved)) throw new Error(resolved.error);

    expect(resolved.selectedModel).toBe("openai/gpt-oss-120b");
    expect(resolved.stages.planner.primaryModelId).toBe("openai/gpt-oss-20b");
    expect(resolved.stages.summary.primaryModelId).toBe("qwen/qwen3.8-27b");
  });

  it("shifts summarizer off Qwen when the user selects Qwen 3.8 27B for synthesis", () => {
    const resolved = resolveModels({
      model: "qwen/qwen3.8-27b",
      apiKey: "gsk_test",
      db: null,
    });
    if (isResolutionError(resolved)) throw new Error(resolved.error);

    expect(resolved.selectedModel).toBe("qwen/qwen3.8-27b");
    expect(resolved.stages.summary.primaryModelId).toBe("openai/gpt-oss-20b");
    expect(resolved.stages.planner.primaryModelId).toBe("openai/gpt-oss-20b");
  });
});

describe("per-model reasoning options and OTPM synthesis caps", () => {
  it("caps Qwen synthesis maxOutputTokens under 1,000 OTPM while preserving 3,500 on GPT-OSS", () => {
    expect(maxSynthesisOutputTokens("qwen/qwen3.8-27b", 3_500)).toBe(900);
    expect(maxSynthesisOutputTokens("openai/gpt-oss-120b", 3_500)).toBe(3_500);
    expect(maxSynthesisOutputTokens("openai/gpt-oss-20b", 3_500)).toBe(3_500);
    expect(maxSummaryOutputTokens("qwen/qwen3.8-27b", 650)).toBe(450);
    expect(maxSummaryOutputTokens("openai/gpt-oss-20b", 650)).toBe(650);
  });

  it("uses zero reasoning on Qwen auxiliary calls, low effort on GPT-OSS auxiliary calls, and effort-scaled synthesis reasoning on GPT-OSS", () => {
    expect(groqReasoningOptions("qwen/qwen3.8-27b", "auxiliary")).toEqual({
      groq: { reasoningEffort: "none", reasoningFormat: "hidden" },
    });
    expect(groqReasoningOptions("openai/gpt-oss-20b", "auxiliary")).toEqual({
      groq: { reasoningEffort: "low", reasoningFormat: "parsed" },
    });
    expect(groqReasoningOptions("qwen/qwen3.8-27b", "synthesis", "high")).toEqual({
      groq: { reasoningFormat: "parsed" },
    });
    expect(groqReasoningOptions("openai/gpt-oss-120b", "synthesis", "high")).toEqual({
      groq: { reasoningFormat: "parsed", reasoningEffort: "medium" },
    });
    expect(groqReasoningOptions("openai/gpt-oss-120b", "synthesis", "low")).toEqual({
      groq: { reasoningFormat: "parsed", reasoningEffort: "low" },
    });
    expect(groqReasoningOptions("custom/non-reasoning", "synthesis")).toBeUndefined();
  });

  it("excludes primaryModel from fallbackModelsFor and prioritizes high-headroom models", () => {
    expect(fallbackModelsFor("openai/gpt-oss-120b")).toEqual([
      "openai/gpt-oss-20b",
      "qwen/qwen3.8-27b",
    ]);
    expect(fallbackModelsFor("qwen/qwen3.8-27b")).toEqual([
      "openai/gpt-oss-120b",
      "openai/gpt-oss-20b",
    ]);
  });
});
