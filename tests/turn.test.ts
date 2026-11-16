import { APICallError, type LanguageModel, type generateText } from "ai";
import { describe, expect, it } from "vitest";
import { clientErrorMessage, executeTurn } from "@/lib/agent/turn";
import type { ResolvedModels } from "@/lib/agent/models";
import type { StageRunner } from "@/lib/agent/stage";
import { describeChatError } from "@/lib/chat-error";
import { effortConfig } from "@/lib/effort";
import type { ResearchOutcome } from "@/lib/research";

const fakeModel = (id: string) => ({ modelId: id }) as unknown as LanguageModel;

const OUTCOME: ResearchOutcome = {
  searched: true,
  evidenceBlock: "[Source 1] Example evidence",
  totalSources: 1,
  sources: [{ url: "https://example.com/a", title: "Example" }],
  steps: [
    {
      round: 1,
      phase: "done",
      query: "example query",
      sources: [{ url: "https://example.com/a", title: "Example" }],
    },
  ],
};

function makeHarness(opts?: {
  synthesisModelId?: string;
  outcome?: ResearchOutcome;
  generateResult?: {
    text: string;
    reasoningText?: string;
    finishReason?: string;
  };
}) {
  const synthId = opts?.synthesisModelId ?? "openai/gpt-oss-120b";
  const calls: Array<Parameters<typeof generateText>[0]> = [];

  const runner = (id: string): StageRunner => ({
    lease: async () => ({ model: fakeModel(id), modelId: id }),
  });
  const resolved: ResolvedModels = {
    pools: { reasoning: [synthId], summarizer: ["openai/gpt-oss-20b"] },
    stages: {
      synthesis: runner(synthId),
      planner: runner("openai/gpt-oss-120b"),
      summary: runner("openai/gpt-oss-20b"),
    },
  };

  const run = (effort = effortConfig("medium"), signal = new AbortController().signal) =>
    executeTurn({
      requestId: "req12345",
      query: "what is new?",
      effort,
      modelMessages: [{ role: "user", content: "what is new?" }],
      signal,
      deps: {
        resolveModels: () => resolved,
        runResearch: async (input) => {
          const out = opts?.outcome ?? OUTCOME;
          await input.onProgress?.({ steps: out.steps, sources: out.sources });
          return out;
        },
        generateText: (async (input: Parameters<typeof generateText>[0]) => {
          calls.push(input);
          const r = opts?.generateResult ?? {
            text: "Verified [Example](https://example.com/a) and [Fake](https://evil.example/x).",
            reasoningText: "Checked primary evidence.",
            finishReason: "stop",
          };
          return {
            text: r.text,
            reasoningText: r.reasoningText,
            finishReason: r.finishReason ?? "stop",
            usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
          };
        }) as unknown as typeof generateText,
      },
    });

  return { calls, run };
}

describe("executeTurn", () => {
  it("runs research, verifies citations, and returns a durable ChatMessage with reasoning and steps", async () => {
    const h = makeHarness();
    const out = await h.run();
    if ("error" in out) throw new Error(out.error);

    expect(out.message.role).toBe("assistant");
    expect(out.message.text).toContain("[Example](https://example.com/a)");
    expect(out.message.text).not.toContain("evil.example");
    expect(out.message.text).toContain("Fake");
    expect(out.message.reasoning).toBe("Checked primary evidence.");
    expect(out.message.steps).toHaveLength(1);
    expect(out.message.sources).toEqual([{ url: "https://example.com/a", title: "Example" }]);
  });

  it("adapts synthesis prompt depth to effort level and switches to compact prompt on Qwen", async () => {
    const hDeep = makeHarness({ synthesisModelId: "openai/gpt-oss-120b" });
    await hDeep.run(effortConfig("high"));
    expect(hDeep.calls[0].system).toContain("Depth & Structure (Deep Research)");
    expect(hDeep.calls[0].maxOutputTokens).toBe(4_000);

    const hQwen = makeHarness({ synthesisModelId: "qwen/qwen3.8-27b" });
    await hQwen.run(effortConfig("high"));
    expect(hQwen.calls[0].maxOutputTokens).toBe(900);
    expect(hQwen.calls[0].system).toContain("Depth & Structure (Compact Output Budget)");
  });

  it("discloses clearly when a non-empty answer hits finishReason === 'length' instead of silently cutting off", async () => {
    const h = makeHarness({
      generateResult: { text: "Partial answer cut off mid-sentence", finishReason: "length" },
    });
    const out = await h.run();
    if ("error" in out) throw new Error(out.error);
    expect(out.message.text).toContain("Partial answer cut off mid-sentence");
    expect(out.message.text).toContain("reached the model's single-turn output token limit");
  });

  it("falls back to a helpful explanation when the model finishes with empty text", async () => {
    const h = makeHarness({
      generateResult: { text: "<think>spent all tokens thinking</think>", finishReason: "length" },
    });
    const out = await h.run();
    if ("error" in out) throw new Error(out.error);
    expect(out.message.text).toContain("ran out of output space");
  });

  it("aborts immediately when signal is already aborted", async () => {
    const h = makeHarness();
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(h.run(effortConfig("medium"), ctrl.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
  });
});

describe("clientErrorMessage", () => {
  const SECRET = "org_01hxsecret";
  const providerError = (statusCode: number) =>
    new APICallError({
      message: `Provider said no to organization ${SECRET}`,
      url: "https://api.groq.com/openai/v1/chat/completions",
      requestBodyValues: {},
      statusCode,
      responseBody: JSON.stringify({ error: { message: `details for ${SECRET}` } }),
    });

  it("maps provider errors to safe messages aligned with describeChatError without leaking secrets", () => {
    const timeout = new Error("The operation was aborted due to timeout");
    timeout.name = "TimeoutError";
    const cases: Array<[unknown, string]> = [
      [providerError(401), "API key rejected"],
      [providerError(404), "Model not available"],
      [providerError(413), "Request too large for the model"],
      [providerError(503), "The server hit an error"],
      [providerError(429), "Model rate limit reached"],
      [timeout, "The request timed out"],
      [providerError(400), "Something went wrong"],
      [new Error(`internal failure involving ${SECRET}`), "Something went wrong"],
    ];

    for (const [error, expectedTitle] of cases) {
      const text = clientErrorMessage(error, "req99999");
      expect(text).not.toContain(SECRET);
      expect(describeChatError(new Error(text)).title).toBe(expectedTitle);
    }
  });
});
