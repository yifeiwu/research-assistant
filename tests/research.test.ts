import { describe, expect, it } from "vitest";
import {
  budgetNotesFairly,
  parsePlainTextLines,
  parseQueryPlan,
  runResearchPipeline,
  selectDeduplicatedDocs,
} from "@/lib/research";
import { effortConfig } from "@/lib/effort";
import type { ExaDocument } from "@/lib/exa";
import type { StageRunner } from "@/lib/agent/stage";

const doc = (url: string): ExaDocument => ({ url, title: url, text: "x" });

/** Every port is injected in these tests, so no model should be leased. */
const unusedStage = (id: string): StageRunner => ({
  primaryModelId: id,
  lease: async () => {
    throw new Error(`unexpected ${id} model lease`);
  },
});
const stages = { planner: unusedStage("planner"), summary: unusedStage("summary") };

describe("parsePlainTextLines", () => {
  it("parses NO_SEARCH", () => {
    expect(parsePlainTextLines("NO_SEARCH", { stopToken: "NO_SEARCH", maxLines: 4 })).toEqual({ stopped: true, lines: [] });
  });
  it("strips bullets/numbering and dedupes", () => {
    const out = parsePlainTextLines("1. alpha query\n- beta query\nalpha query", { stopToken: "NO_SEARCH", maxLines: 4 });
    expect(out.lines).toEqual(["alpha query", "beta query"]);
  });
});

describe("parseQueryPlan", () => {
  it("extracts BRIEF line and remaining search queries", () => {
    const raw = [
      "<think>resolve pronouns</think>",
      "BRIEF: Compare Acme Corp and Beta Inc Q4 2026 operating margins",
      "Acme Corp Q4 2026 operating margin filing",
      "Beta Inc Q4 2026 operating margin filing",
      "Acme vs Beta margin analyst critique 2026",
    ].join("\n");
    expect(parseQueryPlan(raw, { maxQueries: 3 })).toEqual({
      stopped: false,
      brief: "Compare Acme Corp and Beta Inc Q4 2026 operating margins",
      queries: [
        "Acme Corp Q4 2026 operating margin filing",
        "Beta Inc Q4 2026 operating margin filing",
        "Acme vs Beta margin analyst critique 2026",
      ],
    });
  });

  it("handles NO_SEARCH and plain query lists without BRIEF", () => {
    expect(parseQueryPlan("NO_SEARCH", { maxQueries: 2 })).toEqual({
      stopped: true,
      queries: [],
    });
    expect(parseQueryPlan("alpha query\nbeta query", { maxQueries: 2 })).toEqual({
      stopped: false,
      queries: ["alpha query", "beta query"],
    });
  });
});

describe("selectDeduplicatedDocs", () => {
  it("interleaves batches and dedupes by trailing slash", () => {
    const seen = new Set<string>();
    const out = selectDeduplicatedDocs([], [[doc("https://a.com/1"), doc("https://a.com/2")], [doc("https://a.com/1/"), doc("https://b.com/1")]], seen, 3);
    expect(out.map((d) => d.url)).toEqual(["https://a.com/1", "https://a.com/2", "https://b.com/1"]);
  });

  it("drops empty pages, caps per-domain clustering on Pass 1, and backfills when sparse", () => {
    const substantive = (url: string, body = " substantive analysis ".repeat(15)): ExaDocument => ({
      url,
      title: url,
      text: body,
    });

    // Empty search doc is skipped; 3 subdomains of vendor.com get capped at 2 so independent org is included.
    const seen = new Set<string>();
    const diverse = selectDeduplicatedDocs(
      [],
      [
        [
          { url: "https://empty.org/dead", title: "Dead", text: "   " },
          substantive("https://www.vendor.com/p1"),
          substantive("https://blog.vendor.com/p2"),
          substantive("https://docs.vendor.com/p3"),
        ],
        [substantive("https://independent.edu/study")],
      ],
      seen,
      3,
    );
    expect(diverse.map((d) => d.url)).toEqual([
      "https://www.vendor.com/p1",
      "https://independent.edu/study",
      "https://blog.vendor.com/p2",
    ]);

    // When only one domain has results, Pass 2 backfills up to maxCount rather than starving the round.
    const sparseSeen = new Set<string>();
    const backfilled = selectDeduplicatedDocs(
      [],
      [
        [
          substantive("https://onlydomain.com/1"),
          substantive("https://onlydomain.com/2"),
          substantive("https://onlydomain.com/3"),
        ],
      ],
      sparseSeen,
      3,
    );
    expect(backfilled).toHaveLength(3);
  });
});

describe("budgetNotesFairly", () => {
  it("sheds irrelevant notes first and preserves short later-round notes via water-filling", () => {
    const round1Long = "R1 ".repeat(3_500); // ~10,500 chars
    const round1Irrelevant = "### Off-topic\nURL: https://x.com\n- Irrelevant to research question.";
    const round2Concise = "### Round 2 Gap Fill\nURL: https://r2.org\n- [Fact] Exact figure is 93.4%.";

    const out = budgetNotesFairly(
      [round1Long, round1Irrelevant, round2Concise],
      1_500, // 6,000 chars budget
      { separator: "\n\n---\n\n", labelSources: true, trimMarker: "[Trimmed]" },
    );

    expect(out.text).not.toContain("Irrelevant to research question");
    // Short Round 2 note is kept completely intact rather than dropped behind Round 1's oversized note!
    expect(out.text).toContain("Exact figure is 93.4%.");
    expect(out.text).toContain("[Trimmed]");
    expect(out.trimmedCount).toBe(2); // 1 dropped irrelevant + 1 truncated R1 note
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
      stages,
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
      stages,
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
      stages,
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

  it("reports how many rounds ran and where the time went", async () => {
    const writer = { write: () => {} } as never;
    const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    let searches = 0;
    const outcome = await runResearchPipeline({
      messages: [],
      query: "what happened",
      effort: effortConfig("medium"),
      stages,
      writer,
      requestId: "test1234",
      deps: {
        planner: {
          planQueries: async () => ({ stopped: false, queries: ["first"] }),
          // One follow-up round, then enough.
          planFollowUps: async () => ({ stopped: false, queries: ["second"] }),
        },
        search: {
          search: async () => {
            await pause(40);
            return { docs: [doc(`https://a.com/${++searches}`)] };
          },
          fetchContents: async () => ({ docs: [] }),
        },
        condenser: { condense: async () => ({ notes: ["note"], fallbackCount: 0 }) },
      },
    });

    expect(outcome.stats?.rounds).toBe(2);
    // Two rounds of one 40ms search each; the other stages took no time.
    expect(outcome.stats?.searchMs).toBeGreaterThanOrEqual(70);
    for (const stage of ["planMs", "readMs", "gapCheckMs"] as const) {
      expect(outcome.stats?.[stage]).toBeLessThan(30);
    }
  });

  it("trims the evidence block to the synthesis token budget and discloses it", async () => {
    const writer = { write: () => {} } as never;
    const bigNote = "x".repeat(30_000); // ~7,500 tokens, over the 3,000 budget
    const outcome = await runResearchPipeline({
      messages: [],
      query: "q",
      effort: effortConfig("medium"),
      stages,
      writer,
      requestId: "test1234",
      deps: {
        planner: {
          planQueries: async () => ({ stopped: false, queries: ["q"] }),
          planFollowUps: async () => ({ stopped: true, queries: [] }),
        },
        search: {
          search: async () => ({ docs: [doc("https://a.com/1"), doc("https://a.com/2")] }),
          fetchContents: async () => ({ docs: [] }),
        },
        condenser: { condense: async () => ({ notes: [bigNote, bigNote], fallbackCount: 0 }) },
      },
    });
    // 3,000-token budget ≈ 12,000 chars plus headers/markers.
    expect(outcome.evidenceBlock.length).toBeLessThan(13_000);
    expect(outcome.evidenceBlock).toContain("trimmed to fit");
    expect(outcome.degraded?.messages.join(" ")).toContain("token budget");
  });

  it("runs sequential rounds until the gap check says DONE", async () => {
    const chunks: { data?: { round?: number; phase?: string } }[] = [];
    const writer = { write: (c: unknown) => chunks.push(c as never) } as never;
    const searchCalls: string[] = [];
    const gapPriors: string[][] = [];
    let gapCall = 0;
    const outcome = await runResearchPipeline({
      messages: [],
      query: "q",
      effort: effortConfig("high"),
      stages,
      writer,
      requestId: "test1234",
      deps: {
        planner: {
          planQueries: async () => ({ stopped: false, queries: ["q1", "q2"] }),
          planFollowUps: async ({ priorQueries }: { priorQueries: string[] }) => {
            gapPriors.push([...priorQueries]);
            gapCall += 1;
            if (gapCall === 1) return { stopped: false, queries: ["q1", "f1"] }; // duplicate must be filtered
            if (gapCall === 2) return { stopped: false, queries: ["f2"] };
            return { stopped: true, queries: [] };
          },
        },
        search: {
          search: async (q: string) => {
            searchCalls.push(q);
            return { docs: [doc(`https://ex.com/${encodeURIComponent(q)}`)] };
          },
          fetchContents: async () => ({ docs: [] }),
        },
        condenser: {
          condense: async (docs: ExaDocument[]) => ({ notes: docs.map((d) => `note ${d.url}`), fallbackCount: 0 }),
        },
      },
    });
    expect(outcome.searched).toBe(true);
    expect(searchCalls).toEqual(["q1", "q2", "f1", "f2"]);
    expect(gapPriors).toEqual([["q1", "q2"], ["q1", "q2", "f1"], ["q1", "q2", "f1", "f2"]]);
    expect(outcome.totalSources).toBe(4);
    const doneRounds = chunks.filter((c) => c.data?.phase === "done").map((c) => c.data?.round);
    expect(doneRounds).toEqual([1, 2, 3]);
  });

  it("stops before the gap check once notes already fill the synthesis evidence budget", async () => {
    const writer = { write: () => {} } as never;
    let gapCalls = 0;
    const outcome = await runResearchPipeline({
      messages: [],
      query: "q",
      effort: effortConfig("high"),
      stages,
      writer,
      requestId: "test1234",
      deps: {
        planner: {
          planQueries: async () => ({ stopped: false, queries: ["q1"] }),
          planFollowUps: async () => {
            gapCalls += 1;
            return { stopped: false, queries: ["f1"] };
          },
        },
        search: {
          search: async () => ({ docs: [doc("https://a.com/1")] }),
          fetchContents: async () => ({ docs: [] }),
        },
        // ~7,500 tokens of notes, over the 3,000-token evidence budget.
        condenser: { condense: async () => ({ notes: ["x".repeat(30_000)], fallbackCount: 0 }) },
      },
    });
    expect(gapCalls).toBe(0);
    expect(outcome.totalSources).toBe(1);
  });

  it("trims the notes sent to the gap check to the gap-check budget", async () => {
    const writer = { write: () => {} } as never;
    let gapNotes = "";
    await runResearchPipeline({
      messages: [],
      query: "q",
      effort: effortConfig("medium"),
      stages,
      writer,
      requestId: "test1234",
      deps: {
        planner: {
          planQueries: async () => ({ stopped: false, queries: ["q1"] }),
          planFollowUps: async ({ notes }: { notes: string }) => {
            gapNotes = notes;
            return { stopped: true, queries: [] };
          },
        },
        search: {
          search: async () => ({ docs: [doc("https://a.com/1")] }),
          fetchContents: async () => ({ docs: [] }),
        },
        // ~2,000 tokens: under the evidence budget, over the 1,000-token gap budget.
        condenser: { condense: async () => ({ notes: ["x".repeat(8_000)], fallbackCount: 0 }) },
      },
    });
    expect(gapNotes.length).toBe(4_000);
  });

  it("uses all available rounds on high effort when gaps keep coming", async () => {
    const writer = { write: () => {} } as never;
    let gapCall = 0;
    let condenseCalls = 0;
    const outcome = await runResearchPipeline({
      messages: [],
      query: "q",
      effort: effortConfig("high"),
      stages,
      writer,
      requestId: "test1234",
      deps: {
        planner: {
          planQueries: async () => ({ stopped: false, queries: ["q1"] }),
          planFollowUps: async () => {
            gapCall += 1;
            return { stopped: false, queries: [`f${gapCall}`] };
          },
        },
        search: {
          search: async (q: string) => ({ docs: [doc(`https://ex.com/${encodeURIComponent(q)}`)] }),
          fetchContents: async () => ({ docs: [] }),
        },
        condenser: {
          condense: async (docs: ExaDocument[]) => {
            condenseCalls += 1;
            return { notes: docs.map((d) => `note ${d.url}`), fallbackCount: 0 };
          },
        },
      },
    });
    // 4 rounds total, gap check runs only between rounds (3 times).
    expect(condenseCalls).toBe(4);
    expect(gapCall).toBe(3);
    expect(outcome.totalSources).toBe(4);
  });

  it("returns no degraded signal on a clean run", async () => {
    const writer = { write: () => {} } as never;
    const outcome = await runResearchPipeline({
      messages: [],
      query: "q",
      effort: effortConfig("medium"),
      stages,
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

  it("propagates planner BRIEF to condenser and gap-check, and plans 3 initial queries on high effort", async () => {
    const writer = { write: () => {} } as never;
    let seenMaxQueries = 0;
    const condenseQueries: string[] = [];
    const gapQueries: string[] = [];

    await runResearchPipeline({
      messages: [],
      query: "how do their margins compare?",
      effort: effortConfig("high"),
      stages,
      writer,
      requestId: "testbrief",
      deps: {
        planner: {
          planQueries: async ({ maxQueries }) => {
            seenMaxQueries = maxQueries;
            return {
              stopped: false,
              brief: "Compare Q4 2026 operating margins of Nvidia and AMD",
              queries: ["nvidia q4 2026 margin", "amd q4 2026 margin", "nvidia vs amd margin analysis"],
            };
          },
          planFollowUps: async ({ query: gapQ }) => {
            gapQueries.push(gapQ);
            return { stopped: true, queries: [] };
          },
        },
        search: {
          search: async (q) => ({ docs: [doc(`https://ex.com/${encodeURIComponent(q)}`)] }),
          fetchContents: async () => ({ docs: [] }),
        },
        condenser: {
          condense: async (docs, input) => {
            condenseQueries.push(input.query);
            return { notes: docs.map((d) => `note ${d.url}`), fallbackCount: 0 };
          },
        },
      },
    });

    expect(seenMaxQueries).toBe(3);
    expect(condenseQueries).toEqual(["Compare Q4 2026 operating margins of Nvidia and AMD"]);
    expect(gapQueries).toEqual(["Compare Q4 2026 operating margins of Nvidia and AMD"]);
  });
});
