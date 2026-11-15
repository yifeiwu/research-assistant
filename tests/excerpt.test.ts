import { describe, expect, it } from "vitest";
import { selectRelevantExcerpt } from "@/lib/excerpt";
import { parseStructuredSearchQuery } from "@/lib/exa";

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

  it("appends non-redundant full-document highlights while skipping highlights already in the excerpt", () => {
    const rawBody = [
      "Executive overview of the 2026 semiconductor filing.",
      "",
      "General legal disclaimers and forward-looking statements. ".repeat(40),
      "",
      "## Revenue Breakdown",
      "",
      "Data-center segment revenue grew 48% year-over-year to $18.4B.",
    ].join("\n");

    const out = selectRelevantExcerpt(
      rawBody,
      "data-center revenue and wafer yield",
      1_200,
      [
        "Data-center segment revenue grew 48% year-over-year to $18.4B.", // duplicate -> skipped
        "Footnote 19 (page 84): 2nm gate-all-around wafer yield reached 71.5% in October 2026.", // beyond rawBody -> merged!
      ],
    );

    expect(out.length).toBeLessThanOrEqual(1_200);
    expect(out).toContain("### Full-Document Highlights");
    expect(out).toContain("71.5%");
    // Duplicate highlight should only appear once (in the body excerpt, not repeated in highlights).
    expect(out.split("$18.4B").length - 1).toBe(1);
  });
});

describe("parseStructuredSearchQuery", () => {
  const fixedNow = new Date("2026-11-16T00:00:00.000Z");

  it("parses RECENT:, RECENT[90d]:, and EXACT: operator prefixes", () => {
    expect(parseStructuredSearchQuery("EXACT: CVE-2026-44120 advisory", fixedNow)).toEqual({
      query: "CVE-2026-44120 advisory",
      searchType: "keyword",
    });

    expect(parseStructuredSearchQuery("RECENT[90d]: HBM4 spot pricing", fixedNow)).toEqual({
      query: "HBM4 spot pricing",
      startPublishedDate: "2026-08-18",
    });

    expect(
      parseStructuredSearchQuery("RECENT: EXACT: Form 10-K Item 7A", fixedNow),
    ).toEqual({
      query: "Form 10-K Item 7A",
      searchType: "keyword",
      startPublishedDate: "2025-11-16",
    });

    expect(parseStructuredSearchQuery("plain semantic query", fixedNow)).toEqual({
      query: "plain semantic query",
    });
  });
});
