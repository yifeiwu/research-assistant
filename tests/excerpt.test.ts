import { describe, expect, it } from "vitest";
import { selectRelevantExcerpt } from "@/lib/excerpt";

describe("selectRelevantExcerpt", () => {
  it("returns short text unchanged and fast-paths unstructured single-block text", () => {
    expect(selectRelevantExcerpt("short text", "query", 500)).toBe("short text");

    const singleBlock = "abcdef".repeat(1_000);
    expect(selectRelevantExcerpt(singleBlock, "query", 1_200)).toBe(
      singleBlock.slice(0, 1_200),
    );
  });

  it("strips cookie/nav boilerplate and selects deep query-matching passages in document order", () => {
    const fillerParagraph = (n: number) =>
      `Background section ${n}: general corporate history and broad industry overview with unrelated narrative padding `.repeat(
        8,
      );

    const doc = [
      "Skip to main content",
      "Home | Products | Enterprise | Pricing | Documentation | Sign in",
      "We use cookies to improve your experience on our site.",
      "",
      "Acme Cloud announced its 2026 infrastructure platform update covering storage and compute tiers.",
      "",
      fillerParagraph(1),
      "",
      fillerParagraph(2),
      "",
      fillerParagraph(3),
      "",
      "## Q4 Margin & Latency Benchmarks",
      "",
      "| Tier | P99 Latency | Gross Margin |",
      "| --- | --- | --- |",
      "| Standard | 42 ms | 68.4% |",
      "| Ultra | 11 ms | 74.2% |",
      "",
      fillerParagraph(4),
      "",
      "## Methodology & Limitations",
      "",
      "Independent testing across 12,000 production workloads in 2026 showed Q4 gross margin expanded by 580 bps due to custom silicon.",
    ].join("\n");

    expect(doc.length).toBeGreaterThan(3_500);

    const excerpt = selectRelevantExcerpt(
      doc,
      "Acme Cloud Q4 gross margin and P99 latency benchmarks",
      1_400,
    );

    expect(excerpt.length).toBeLessThanOrEqual(1_400);
    expect(excerpt).not.toContain("Skip to main content");
    expect(excerpt).not.toContain("Home | Products | Enterprise");
    expect(excerpt).not.toContain("We use cookies");

    // Preserves opening lead framing AND deep benchmark table / findings in document order.
    expect(excerpt).toContain("Acme Cloud announced its 2026 infrastructure platform");
    expect(excerpt).toContain("74.2%");
    expect(excerpt).toContain("11 ms");

    const leadPos = excerpt.indexOf("Acme Cloud announced");
    const tablePos = excerpt.indexOf("74.2%");
    expect(leadPos).toBeGreaterThanOrEqual(0);
    expect(tablePos).toBeGreaterThan(leadPos);
    expect(excerpt).toContain("[...]");
  });
});
