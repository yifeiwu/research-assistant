import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return { ...actual, generateText: vi.fn() };
});

import { generateText } from "ai";
import { condenseSourcesDetailed, parseBatchNotes } from "@/lib/pipeline";
import type { ExaDocument } from "@/lib/exa";

const mockGenerate = vi.mocked(generateText);

const longDoc = (url: string, fill = "x", chars = 5_000): ExaDocument => ({
  url,
  title: url,
  text: fill.repeat(chars),
});

const opts = { model: {} as never, query: "q", disableCache: true as const };

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
    // Fallback excerpts are capped at 4,000 chars of the source body.
    expect(out.notes[0]).toContain("x".repeat(4_000));
    expect(out.notes[0]).not.toContain("x".repeat(4_001));
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
    // 20,000-char batch cap plus headings/instructions overhead.
    expect(prompt.length).toBeLessThan(22_000);
  });
});
