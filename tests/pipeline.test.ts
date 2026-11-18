import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return { ...actual, generateText: vi.fn() };
});

import { generateText } from "ai";
import {
  condenseSourcesDetailed,
  formatDocExcerpt,
  parseBatchNotes,
  stripThinking,
} from "@/lib/pipeline";
import type { ExaDocument } from "@/lib/exa";
import type { StageRunner } from "@/lib/agent/stage";

const mockGenerate = vi.mocked(generateText);

const longDoc = (url: string, fill = "x", chars = 5_000): ExaDocument => ({
  url,
  title: url,
  text: fill.repeat(chars),
});

const stageFor = (modelId: string): StageRunner => ({
  run: async (req) => ({
    value: (
      await req.execute(
        { model: {} as never, modelId },
        req.signal ?? new AbortController().signal,
      )
    ).value,
    modelId,
  }),
});

const opts = { stage: stageFor("summary"), query: "q", disableCache: true as const };

beforeEach(() => {
  mockGenerate.mockReset();
});

describe("parseBatchNotes & formatDocExcerpt", () => {
  it("splits headed sections in source order, missing sections become null", () => {
    const raw = "### Source 2\n- two\n\n### Source 1\n- one";
    expect(parseBatchNotes(raw, 3)).toEqual(["- one", "- two", null]);
  });

  it("strips leading thinking blocks without truncating literal <think> mentions in answers", () => {
    const raw = "<think>plan</think>### Source 9\n- nope\n### Source 1\n- yes";
    expect(parseBatchNotes(raw, 1)).toEqual(["- yes"]);
    expect(
      stripThinking(
        "<think>internal reasoning</think>\nQwen uses `<think>` tokens before answering, followed by the full explanation.",
      ),
    ).toBe(
      "Qwen uses `<think>` tokens before answering, followed by the full explanation.",
    );
  });

  it("tolerates common model heading variations and headingless single-source outputs", () => {
    const varied = [
      "### Source 1: Official Stripe Docs",
      "- [Fact] 2.9% + 30c",
      "## Source 2 — Benchmark",
      "- [Fact] 14ms p99",
      "**Source 3:**",
      "- [Claim] 2x throughput",
      "<source 4>",
      "- [Fact] GA in May 2026",
      "</source 4>",
    ].join("\n");
    expect(parseBatchNotes(varied, 4)).toEqual([
      "- [Fact] 2.9% + 30c",
      "- [Fact] 14ms p99",
      "- [Claim] 2x throughput",
      "- [Fact] GA in May 2026",
    ]);

    // Single-source batch where the model omits the `### Source 1` heading altogether:
    expect(
      parseBatchNotes("- Profile: official-docs | Caveat: none\n- [Fact] 99.95% SLA", 1),
    ).toEqual(["- Profile: official-docs | Caveat: none\n- [Fact] 99.95% SLA"]);
  });

  it("formats Exa neural highlights ahead of bounded lead context", () => {
    const excerpt = formatDocExcerpt(
      {
        url: "https://bench.dev/r",
        text: "Introductory overview of the benchmark suite.",
        highlights: ["Z900 achieved 4.8 TB/s sustained HBM4 bandwidth at 620W."],
      },
      2_000,
    );
    expect(excerpt).toContain("- Z900 achieved 4.8 TB/s");
    expect(excerpt).toContain("Lead context:\nIntroductory overview");
  });
});

describe("condenseSourcesDetailed (batched)", () => {
  it("condenses all long sources in a single fail-fast model call", async () => {
    mockGenerate.mockResolvedValue({
      text: "### Source 1\n- a\n### Source 2\n- b\n### Source 3\n- c",
    } as never);
    const docs = [longDoc("https://a.com"), longDoc("https://b.com"), longDoc("https://c.com")];
    const out = await condenseSourcesDetailed(docs, opts);
    expect(mockGenerate).toHaveBeenCalledTimes(1);
    expect(mockGenerate.mock.calls[0][0]).toMatchObject({ maxRetries: 0 });
    const prompt = String(mockGenerate.mock.calls[0][0].prompt);
    for (const d of docs) expect(prompt).toContain(d.url);
    expect(out.fallbackCount).toBe(0);
    expect(out.notes).toHaveLength(3);
    expect(out.notes[0]).toContain("- a");
    expect(out.notes[2]).toContain("- c");
  });

  it("falls back to bounded excerpts when the batch call fails, without retrying", async () => {
    mockGenerate.mockRejectedValue(new Error("Rate limit reached"));
    const docs = [longDoc("https://a.com"), longDoc("https://b.com")];
    const out = await condenseSourcesDetailed(docs, opts);
    expect(mockGenerate).toHaveBeenCalledTimes(1);
    expect(out.fallbackCount).toBe(2);
    expect(out.notes[0]).toContain("x".repeat(2_500));
    expect(out.notes[0]).not.toContain("x".repeat(2_501));
  });

  it("falls back only for sources missing from the batch response when retryMissing is off, and recovers them cleanly when retryMissing is enabled", async () => {
    mockGenerate.mockResolvedValue({ text: "### Source 1\n- only one" } as never);
    const docs = [longDoc("https://a.com"), longDoc("https://b.com", "y")];
    const out = await condenseSourcesDetailed(docs, opts);
    expect(out.fallbackCount).toBe(1);
    expect(out.notes[0]).toContain("- only one");
    expect(out.notes[1]).toContain("y".repeat(100));

    // With retryMissing enabled (used on Medium & High efforts), Source 2 is retried individually and succeeds!
    mockGenerate.mockReset();
    mockGenerate
      .mockResolvedValueOnce({ text: "### Source 1\n- first note" } as never)
      .mockResolvedValueOnce({ text: "- [Fact] recovered second note" } as never);
    const recovered = await condenseSourcesDetailed(docs, {
      ...opts,
      retryMissing: true,
    });
    expect(mockGenerate).toHaveBeenCalledTimes(2);
    expect(recovered.fallbackCount).toBe(0);
    expect(recovered.notes[0]).toContain("- first note");
    expect(recovered.notes[1]).toContain("- [Fact] recovered second note");
  });

  it("does not call the model for short highlight-free or empty sources", async () => {
    const docs: ExaDocument[] = [
      { url: "https://a.com", title: "A", text: "short body" },
      { url: "https://b.com", title: "B", text: "   " },
    ];
    const out = await condenseSourcesDetailed(docs, opts);
    expect(mockGenerate).not.toHaveBeenCalled();
    expect(out.notes[0]).toContain("short body");
    expect(out.fallbackCount).toBe(1);
  });

  it("caps total batch input and shrinks further on 4k-context allam-2-7b", async () => {
    mockGenerate.mockResolvedValue({
      text: Array.from({ length: 8 }, (_, i) => `### Source ${i + 1}\n- n${i}`).join("\n"),
    } as never);
    const docs = Array.from({ length: 8 }, (_, i) => longDoc(`https://s${i}.com`, "x", 10_000));
    await condenseSourcesDetailed(docs, opts);
    const prompt = String(mockGenerate.mock.calls[0][0].prompt);
    expect(prompt.length).toBeLessThan(12_000);

    mockGenerate.mockClear();
    mockGenerate.mockResolvedValue({
      text: Array.from({ length: 4 }, (_, i) => `### Source ${i + 1}\n- n${i}`).join("\n"),
    } as never);
    await condenseSourcesDetailed(docs.slice(0, 4), {
      ...opts,
      stage: stageFor("allam-2-7b"),
    });
    const allamPrompt = String(mockGenerate.mock.calls[0][0].prompt);
    expect(allamPrompt.length).toBeLessThan(7_200);
    expect(mockGenerate.mock.calls[0][0].providerOptions).toBeUndefined();
  });

  it("disables reasoning tokens on Qwen summarizer and sets low effort on GPT-OSS", async () => {
    mockGenerate.mockResolvedValue({ text: "### Source 1\n- a" } as never);
    await condenseSourcesDetailed([longDoc("https://a.com")], {
      ...opts,
      stage: stageFor("qwen/qwen3.8-27b"),
    });
    expect(mockGenerate.mock.calls[0][0].providerOptions).toEqual({
      groq: { reasoningEffort: "none", reasoningFormat: "hidden" },
    });

    mockGenerate.mockClear();
    mockGenerate.mockResolvedValue({ text: "### Source 1\n- b" } as never);
    await condenseSourcesDetailed([longDoc("https://b.com")], {
      ...opts,
      stage: stageFor("openai/gpt-oss-20b"),
    });
    expect(mockGenerate.mock.calls[0][0].providerOptions).toEqual({
      groq: { reasoningEffort: "low" },
    });
  });

  it("includes deterministic domain/date headers, scales summary maxOutputTokens by batch size, and avoids false-positive fallback flags on short highlight excerpts", async () => {
    mockGenerate.mockResolvedValue({ text: "### Source 1\n- [Fact] 42% gain" } as never);
    const qwenOut = await condenseSourcesDetailed(
      [
        {
          url: "https://www.nature.com/articles/s41586-026-0001",
          title: "Study",
          publishedDate: "2026-05-10",
          text: "x".repeat(4_000),
        },
      ],
      { ...opts, stage: stageFor("qwen/qwen3.8-27b") },
    );
    // 1-source batch reserves 400 tokens; 4-source batch scales up to 850 tokens (no 450 choke!):
    expect(mockGenerate.mock.calls[0][0].maxOutputTokens).toBe(400);
    expect(qwenOut.notes[0]).toContain("Domain: nature.com | Published: 2026-05-10");

    mockGenerate.mockClear();
    mockGenerate.mockResolvedValue({
      text: [1, 2, 3, 4].map((n) => `### Source ${n}\n- note ${n}`).join("\n"),
    } as never);
    await condenseSourcesDetailed(
      [longDoc("https://1.com"), longDoc("https://2.com"), longDoc("https://3.com"), longDoc("https://4.com")],
      { ...opts, stage: stageFor("qwen/qwen3.8-27b") },
    );
    expect(mockGenerate.mock.calls[0][0].maxOutputTokens).toBe(850);

    mockGenerate.mockClear();
    mockGenerate.mockResolvedValue({ text: "### Source 1\n- [Fact] 42% gain" } as never);
    const gptOut = await condenseSourcesDetailed(
      [{ url: "https://docs.example.org/spec", title: "Spec", text: "y".repeat(4_000) }],
      { ...opts, stage: stageFor("openai/gpt-oss-20b") },
    );
    expect(mockGenerate.mock.calls[0][0].maxOutputTokens).toBe(420);
    expect(gptOut.notes[0]).toContain("Domain: docs.example.org | Published: unlisted");

    // When a compact Exa highlight excerpt (<= 2,500 chars) falls back to raw highlights,
    // 100% of the excerpt reaches synthesis intact so fallbackCount stays 0:
    mockGenerate.mockReset();
    mockGenerate.mockRejectedValue(new Error("Summarizer timeout"));
    const compactHighlightFallback = await condenseSourcesDetailed(
      [
        {
          url: "https://api.example.org/changelog",
          title: "Changelog",
          text: "Short overview.",
          highlights: ["v3.2 reduced cold start latency from 420ms to 95ms."],
        },
      ],
      opts,
    );
    expect(compactHighlightFallback.fallbackCount).toBe(0);
    expect(compactHighlightFallback.notes[0]).toContain("95ms");
  });
});
