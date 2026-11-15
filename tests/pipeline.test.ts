import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return { ...actual, generateText: vi.fn() };
});

import { generateText } from "ai";
import {
  condenseSourcesDetailed,
  parseBatchNotes,
  reduceNotesDetailed,
} from "@/lib/pipeline";
import type { ExaDocument } from "@/lib/exa";
import type { StageRunner } from "@/lib/agent/stage";

const mockGenerate = vi.mocked(generateText);

const longDoc = (url: string, fill = "x", chars = 5_000): ExaDocument => ({
  url,
  title: url,
  text: fill.repeat(chars),
});

/** A summary stage that always grants `modelId` straight away. */
const stageFor = (modelId: string): StageRunner => ({
  primaryModelId: modelId,
  lease: async () => ({ model: {} as never, modelId, waitedMs: 0 }),
});

const opts = { stage: stageFor("summary"), query: "q", disableCache: true as const };

beforeEach(() => {
  mockGenerate.mockReset();
});

describe("parseBatchNotes", () => {
  it("splits headed sections in source order, missing sections become null", () => {
    const raw = "### Source 2\n- two\n\n### Source 1\n- one";
    expect(parseBatchNotes(raw, 3)).toEqual(["- one", "- two", null]);
  });

  it("strips thinking blocks and ignores out-of-range headings", () => {
    const raw = "<think>plan</think>### Source 9\n- nope\n### Source 1\n- yes";
    expect(parseBatchNotes(raw, 1)).toEqual(["- yes"]);
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

  it("falls back to raw excerpts for every source when the batch call fails, without retrying", async () => {
    mockGenerate.mockRejectedValue(new Error("Rate limit reached for model `qwen/qwen3.8-27b`"));
    const docs = [longDoc("https://a.com"), longDoc("https://b.com")];
    const out = await condenseSourcesDetailed(docs, opts);
    expect(mockGenerate).toHaveBeenCalledTimes(1);
    expect(out.fallbackCount).toBe(2);
    // Fallback excerpts come from the per-source input slice (3,000 chars
    // for 2 pending sources), itself under the 4,000-char fallback cap.
    expect(out.notes[0]).toContain("x".repeat(3_000));
    expect(out.notes[0]).not.toContain("x".repeat(3_001));
  });

  it("falls back only for sources missing from the batch response", async () => {
    mockGenerate.mockResolvedValue({ text: "### Source 1\n- only one" } as never);
    const docs = [longDoc("https://a.com"), longDoc("https://b.com", "y")];
    const out = await condenseSourcesDetailed(docs, opts);
    expect(out.fallbackCount).toBe(1);
    expect(out.notes[0]).toContain("- only one");
    expect(out.notes[1]).toContain("y".repeat(100));
  });

  it("does not call the model for short or empty sources", async () => {
    const docs: ExaDocument[] = [
      { url: "https://a.com", title: "A", text: "short body" },
      { url: "https://b.com", title: "B", text: "   " },
    ];
    const out = await condenseSourcesDetailed(docs, opts);
    expect(mockGenerate).not.toHaveBeenCalled();
    expect(out.notes[0]).toContain("short body");
    expect(out.fallbackCount).toBe(1);
  });

  it("caps total batch input so one round stays under the model input budget", async () => {
    mockGenerate.mockResolvedValue({
      text: Array.from({ length: 8 }, (_, i) => `### Source ${i + 1}\n- n${i}`).join("\n"),
    } as never);
    const docs = Array.from({ length: 8 }, (_, i) => longDoc(`https://s${i}.com`, "x", 10_000));
    await condenseSourcesDetailed(docs, opts);
    const prompt = String(mockGenerate.mock.calls[0][0].prompt);
    // 10,000-char batch cap plus headings/instructions overhead.
    expect(prompt.length).toBeLessThan(12_000);
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
      groq: { reasoningEffort: "low", reasoningFormat: "parsed" },
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

  it("extracts deep query-relevant passages rather than only top-of-page filler", async () => {
    mockGenerate.mockRejectedValue(new Error("429"));
    const deepDoc: ExaDocument = {
      url: "https://bench.dev/report",
      title: "Benchmark Report",
      text: [
        "Introductory overview of the annual developer survey.",
        "",
        " Filler paragraph about unrelated topics.".repeat(120),
        "",
        "## Memory Throughput Results",
        "",
        "The Z900 accelerator achieved 4.8 TB/s sustained HBM4 bandwidth at 620W.",
      ].join("\n"),
    };
    const out = await condenseSourcesDetailed([deepDoc], {
      ...opts,
      query: "Z900 HBM4 bandwidth throughput",
    });
    expect(out.fallbackCount).toBe(1);
    expect(out.notes[0]).toContain("4.8 TB/s");
  });

  it("splits high-effort rounds into 2-source micro-batches, retries transient 429s when patientWait is set, and extracts/strips Primary-Refs", async () => {
    let call = 0;
    mockGenerate.mockImplementation((async () => {
      call += 1;
      if (call === 1) {
        throw new Error("Rate limit reached (429): try again in 3s");
      }
      if (call === 2) {
        return {
          text: [
            "### Source 1",
            "- Profile: news | Caveat: secondary press summary",
            "- [Fact] Reported 31% latency drop.",
            "- Primary-Ref: https://arxiv.org/abs/2604.09999",
            "### Source 2",
            "- Profile: blog/forum | Caveat: commentary",
            "- [Claim] Argues memory bandwidth is the bottleneck.",
            "- Primary-Ref: Stanford HELM 2026 Systems Benchmark",
          ].join("\n"),
        } as never;
      }
      return {
        text: [
          "### Source 1",
          "- Profile: official-docs | Caveat: none",
          "- [Fact] TDP is 600W.",
          "### Source 2",
          "- Irrelevant to research question.",
        ].join("\n"),
      } as never;
    }) as never);

    const leaseWaits: Array<number | undefined> = [];
    const patientStage: StageRunner = {
      primaryModelId: "qwen/qwen3.8-27b",
      lease: async (req) => {
        leaseWaits.push(req.maxWaitMs);
        return { model: {} as never, modelId: "qwen/qwen3.8-27b", waitedMs: 0 };
      },
    };

    const docs: ExaDocument[] = [
      {
        url: "https://technews.com/story",
        title: "News",
        text: `Secondary coverage referencing https://www.sec.gov/Archives/edgar/data/1045810/filing.htm and ${"analysis ".repeat(400)}`,
      },
      longDoc("https://blog.dev/post", "b", 5_000),
      longDoc("https://docs.vendor.com/spec", "c", 5_000),
      longDoc("https://noise.com/off", "d", 5_000),
    ];

    const out = await condenseSourcesDetailed(docs, {
      stage: patientStage,
      query: "accelerator latency and TDP",
      batchSize: 2,
      perSourceCharCap: 4_500,
      patientWait: true,
      extractPrimaryRefs: true,
      disableCache: true,
    });

    // 2 micro-batches total, with micro-batch 1 retried once after the 429 -> 3 generateText calls.
    expect(mockGenerate).toHaveBeenCalledTimes(3);
    expect(leaseWaits.every((w) => w && w >= 40_000)).toBe(true);
    expect(out.fallbackCount).toBe(0);
    expect(out.notes).toHaveLength(4);

    // Unretrieved Primary-Ref URLs must be stripped from the note text so synthesis cannot cite unverified URLs!
    expect(out.notes[0]).not.toContain("2604.09999");
    expect(out.notes[1]).not.toContain("Primary-Ref:");

    // Both raw-text authority links (sec.gov) and model-emitted Primary-Ref URLs/titles are captured for hopping.
    expect(out.primaryRefs?.urls).toEqual([
      "https://www.sec.gov/Archives/edgar/data/1045810/filing.htm",
      "https://arxiv.org/abs/2604.09999",
    ]);
    expect(out.primaryRefs?.queries).toEqual([
      "Stanford HELM 2026 Systems Benchmark",
    ]);
  });
});

describe("reduceNotesDetailed (Thematic Reduce)", () => {
  it("clusters oversized multi-round notes, sheds irrelevant sources, and preserves citation links", async () => {
    mockGenerate
      .mockResolvedValueOnce({
        text: "### Sub-brief 1\n- [Fact] Margin hit 74.2% ([Q4 Filing](https://sec.gov/q4)).",
      } as never)
      .mockResolvedValueOnce({
        text: "### Sub-brief 2\n- [Fact] Independent latency measured at 11ms ([Bench](https://bench.org/r)).",
      } as never);

    const notes = [
      `### Q4 Filing\nURL: https://sec.gov/q4\n- [Fact] ${"Margin details ".repeat(450)}`,
      "### Noise\nURL: https://spam.example/1\n- Irrelevant to research question.",
      `### Bench\nURL: https://bench.org/r\n- [Fact] ${"Latency benchmark ".repeat(450)}`,
    ];

    const out = await reduceNotesDetailed(notes, {
      stage: stageFor("openai/gpt-oss-20b"),
      query: "margin and latency",
      targetTokenBudget: 1_200,
      patientWait: true,
    });

    expect(out.reduced).toBe(true);
    expect(mockGenerate).toHaveBeenCalledTimes(2);
    // Irrelevant note was dropped before clustering.
    const allPrompts = mockGenerate.mock.calls.map((c) => String(c[0].prompt)).join("\n");
    expect(allPrompts).not.toContain("spam.example");
    expect(out.evidenceBlock).toContain("[Q4 Filing](https://sec.gov/q4)");
    expect(out.evidenceBlock).toContain("[Bench](https://bench.org/r)");
  });
});
