import { describe, expect, it } from "vitest";
import {
  parsePlainTextLines,
  runResearchPipeline,
  selectDeduplicatedDocs,
} from "@/lib/research";
import { effortConfig } from "@/lib/effort";
import type { ExaDocument } from "@/lib/exa";

const doc = (url: string): ExaDocument => ({ url, title: url, text: "x" });

describe("parsePlainTextLines", () => {
  it("parses NO_SEARCH", () => {
    expect(parsePlainTextLines("NO_SEARCH", { stopToken: "NO_SEARCH", maxLines: 4 })).toEqual({ stopped: true, lines: [] });
  });
  it("strips bullets/numbering and dedupes", () => {
    const out = parsePlainTextLines("1. alpha query\n- beta query\nalpha query", { stopToken: "NO_SEARCH", maxLines: 4 });
    expect(out.lines).toEqual(["alpha query", "beta query"]);
  });
});

describe("selectDeduplicatedDocs", () => {
  it("interleaves batches and dedupes by trailing slash", () => {
    const seen = new Set<string>();
    const out = selectDeduplicatedDocs([], [[doc("https://a.com/1"), doc("https://a.com/2")], [doc("https://a.com/1/"), doc("https://b.com/1")]], seen, 3);
    expect(out.map((d) => d.url)).toEqual(["https://a.com/1", "https://a.com/2", "https://b.com/1"]);
  });
});

describe("runResearchPipeline degraded reporting", () => {
  it("surfaces failed queries and condenser fallbacks", async () => {
    const chunks: { data?: { degraded?: unknown; phase?: string } }[] = [];
    const writer = { write: (c: unknown) => chunks.push(c as never) } as never;
    const outcome = await runResearchPipeline({
      messages: [],
      query: "what happened",
      effort: effortConfig("medium"),
      mainModel: {} as never,
      summaryModel: {} as never,
      supportsReasoning: false,
      writer,
      requestId: "test1234",
      deps: {
        planner: {
          planQueries: async () => ({ stopped: false, queries: ["good query", "bad query"] }),
          planFollowUps: async () => ({ stopped: true, queries: [] }),
        },
        search: {
          search: async (q: string) =>
            q === "bad query" ? { docs: [], error: "exa boom" } : { docs: [doc("https://a.com/1")] },
          fetchContents: async () => ({ docs: [] }),
        },
        condenser: {
          condense: async () => ({ notes: ["note"], fallbackCount: 1 }),
        },
      },
    });
    expect(outcome.searched).toBe(true);
    expect(outcome.sources).toHaveLength(1);
    expect(outcome.degraded?.failedQueries).toEqual(["bad query"]);
    expect(outcome.degraded?.fallbackSources).toBe(1);
    expect(outcome.degraded?.messages.join(" ")).toContain("failed");
    const done = chunks.find((c) => c.data?.phase === "done");
    expect(done?.data?.degraded).toBeTruthy();
  });

  it("flags total retrieval failure as searchFailed, distinct from NO_SEARCH", async () => {
    const writer = { write: () => {} } as never;
    const outcome = await runResearchPipeline({
      messages: [],
      query: "breaking news",
      effort: effortConfig("medium"),
      mainModel: {} as never,
      summaryModel: {} as never,
      supportsReasoning: false,
      writer,
      requestId: "test1234",
      deps: {
        planner: {
          planQueries: async () => ({ stopped: false, queries: ["q1"] }),
          planFollowUps: async () => ({ stopped: true, queries: [] }),
        },
        search: {
          search: async () => ({ docs: [], error: "exa down" }),
          fetchContents: async () => ({ docs: [] }),
        },
        condenser: { condense: async () => ({ notes: [], fallbackCount: 0 }) },
      },
    });
    expect(outcome.searched).toBe(false);
    expect(outcome.searchFailed).toBe(true);
    expect(outcome.degraded?.failedQueries).toEqual(["q1"]);
  });

  it("surfaces planner failure and partial explicit-URL fetches as degraded", async () => {
    const writer = { write: () => {} } as never;
    const outcome = await runResearchPipeline({
      messages: [],
      query: "summarise https://a.com/page please",
      effort: effortConfig("medium"),
      mainModel: {} as never,
      summaryModel: {} as never,
      supportsReasoning: false,
      writer,
      requestId: "test1234",
      deps: {
        planner: {
          planQueries: async () => {
            throw new Error("planner boom");
          },
          planFollowUps: async () => ({ stopped: true, queries: [] }),
        },
        search: {
          search: async () => ({ docs: [doc("https://b.com/1")] }),
          fetchContents: async () => ({ docs: [] }),
        },
        condenser: { condense: async () => ({ notes: ["n"], fallbackCount: 0 }) },
      },
    });
    expect(outcome.searched).toBe(true);
    expect(outcome.degraded?.failedContents).toBe(true);
    expect(outcome.degraded?.failedStages?.join(" ")).toContain("query planning failed");
  });

  it("returns no degraded signal on a clean run", async () => {
    const writer = { write: () => {} } as never;
    const outcome = await runResearchPipeline({
      messages: [],
      query: "q",
      effort: effortConfig("medium"),
      mainModel: {} as never,
      summaryModel: {} as never,
      supportsReasoning: false,
      writer,
      requestId: "test1234",
      deps: {
        planner: {
          planQueries: async () => ({ stopped: false, queries: ["q"] }),
          planFollowUps: async () => ({ stopped: true, queries: [] }),
        },
        search: {
          search: async () => ({ docs: [doc("https://a.com/1")] }),
          fetchContents: async () => ({ docs: [] }),
        },
        condenser: { condense: async () => ({ notes: ["n"], fallbackCount: 0 }) },
      },
    });
    expect(outcome.degraded).toBeUndefined();
  });
});
