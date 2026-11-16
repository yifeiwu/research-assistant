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
  lease: async () => ({ model: {} as never, modelId }),
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

  it("strips thinking blocks and ignores out-of-range headings", () => {
    const raw = "<think>plan</think>### Source 9\n- nope\n### Source 1\n- yes";
    expect(parseBatchNotes(raw, 1)).toEqual(["- yes"]);
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

  it("falls back only for sources missing from the batch response", async () => {
    mockGenerate.mockResolvedValue({ text: "### Source 1\n- only one" } as never);
    const docs = [longDoc("https://a.com"), longDoc("https://b.com", "y")];
    const out = await condenseSourcesDetailed(docs, opts);
    expect(out.fallbackCount).toBe(1);
    expect(out.notes[0]).toContain("- only one");
    expect(out.notes[1]).toContain("y".repeat(100));
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

  it("includes deterministic domain/date headers and scales summary maxOutputTokens by model", async () => {
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
    expect(mockGenerate.mock.calls[0][0].maxOutputTokens).toBe(450);
    expect(qwenOut.notes[0]).toContain("Domain: nature.com | Published: 2026-05-10");

    mockGenerate.mockClear();
    mockGenerate.mockResolvedValue({ text: "### Source 1\n- [Fact] 42% gain" } as never);
    const gptOut = await condenseSourcesDetailed(
      [{ url: "https://docs.example.org/spec", title: "Spec", text: "y".repeat(4_000) }],
      { ...opts, stage: stageFor("openai/gpt-oss-20b") },
    );
    expect(mockGenerate.mock.calls[0][0].maxOutputTokens).toBe(650);
    expect(gptOut.notes[0]).toContain("Domain: docs.example.org | Published: unlisted");
  });
});
