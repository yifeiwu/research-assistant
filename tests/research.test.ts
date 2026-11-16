import { describe, expect, it } from "vitest";
import {
  budgetNotesFairly,
  parsePlainTextQuery,
  parseQueryPlan,
  parseRerankIndices,
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

describe("effortConfig rounds", () => {
  it("configures 0 rounds for low, 3 rounds for medium, and 5 rounds for high", () => {
    expect(effortConfig("low").rounds).toBe(0);
    expect(effortConfig("medium").rounds).toBe(3);
    expect(effortConfig("high").rounds).toBe(5);
  });
});

describe("parsePlainTextQuery", () => {
  it("parses stop tokens", () => {
    expect(parsePlainTextQuery("NO_SEARCH", { stopToken: "NO_SEARCH" })).toEqual({
      stopped: true,
    });
    expect(parsePlainTextQuery("`DONE.`", { stopToken: "DONE" })).toEqual({
      stopped: true,
    });
  });

  it("strips bullets/numbering and skips excluded prior queries", () => {
    const out = parsePlainTextQuery("1. alpha query\n- beta query", {
      stopToken: "DONE",
      exclude: ["Alpha Query"],
    });
    expect(out).toEqual({ stopped: false, query: "beta query" });
  });
});

describe("parseQueryPlan", () => {
  it("extracts BRIEF line and the single initial search query", () => {
    const raw = [
      "<think>resolve pronouns</think>",
      "BRIEF: Compare Acme Corp and Beta Inc Q4 2026 operating margins",
      "Acme Corp vs Beta Inc Q4 2026 operating margin filing",
    ].join("\n");
    expect(parseQueryPlan(raw)).toEqual({
      stopped: false,
      brief: "Compare Acme Corp and Beta Inc Q4 2026 operating margins",
      query: "Acme Corp vs Beta Inc Q4 2026 operating margin filing",
    });
  });

  it("handles NO_SEARCH and plain single query without BRIEF", () => {
    expect(parseQueryPlan("NO_SEARCH")).toEqual({
      stopped: true,
    });
    expect(parseQueryPlan("alpha query")).toEqual({
      stopped: false,
      query: "alpha query",
    });
  });
});

describe("selectDeduplicatedDocs", () => {
  it("dedupes by trailing slash and preserves priority docs first", () => {
    const seen = new Set<string>();
    const out = selectDeduplicatedDocs(
      [doc("https://p.com/explicit")],
      [doc("https://a.com/1"), doc("https://a.com/1/"), doc("https://b.com/1")],
      seen,
      3,
    );
    expect(out.map((d) => d.url)).toEqual([
      "https://p.com/explicit",
      "https://a.com/1",
      "https://b.com/1",
    ]);
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
        { url: "https://empty.org/dead", title: "Dead", text: "   " },
        substantive("https://www.vendor.com/p1"),
        substantive("https://blog.vendor.com/p2"),
        substantive("https://docs.vendor.com/p3"),
        substantive("https://independent.edu/study"),
      ],
      seen,
      3,
    );
    expect(diverse.map((d) => d.url)).toEqual([
      "https://www.vendor.com/p1",
      "https://blog.vendor.com/p2",
      "https://independent.edu/study",
    ]);

    // When only one domain has results, Pass 2 backfills up to maxCount rather than starving the round.
    const sparseSeen = new Set<string>();
    const backfilled = selectDeduplicatedDocs(
      [],
      [
        substantive("https://onlydomain.com/1"),
        substantive("https://onlydomain.com/2"),
        substantive("https://onlydomain.com/3"),
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

describe("runResearchPipeline", () => {
  it("surfaces failed queries and condenser fallbacks across sequential rounds", async () => {
    const chunks: { data?: { degraded?: unknown; phase?: string } }[] = [];
    const writer = { write: (c: unknown) => chunks.push(c as never) } as never;
    let gapCalls = 0;
    const outcome = await runResearchPipeline({
      messages: [],
      query: "what happened",
      effort: effortConfig("medium"),
      stages,
      writer,
      requestId: "test1234",
      deps: {
        planner: {
          planQuery: async () => ({ stopped: false, query: "good query" }),
          planFollowUp: async () => {
            gapCalls += 1;
            return gapCalls === 1 ? { stopped: false, query: "bad query" } : { stopped: true };
          },
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
    expect(outcome.degraded?.join("; ")).toContain("1 search query failed");
    expect(outcome.degraded?.join("; ")).toContain("1 source could only be partially read");
    const doneSteps = chunks.filter((c) => c.data?.phase === "done");
    expect(doneSteps.at(-1)?.data?.degraded).toBeTruthy();
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
          planQuery: async () => ({ stopped: false, query: "q1" }),
          planFollowUp: async () => ({ stopped: true }),
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
    expect(outcome.degraded).toEqual(["1 search query failed"]);
  });

  it("surfaces planner failure and partial explicit-URL fetches as degraded, executing fetchContents and search sequentially", async () => {
    const writer = { write: () => {} } as never;
    let inFlightExa = 0;
    let maxConcurrentExa = 0;
    const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

    const outcome = await runResearchPipeline({
      messages: [],
      query: "summarise https://a.com/page please",
      effort: effortConfig("medium"),
      stages,
      writer,
      requestId: "test1234",
      deps: {
        planner: {
          planQuery: async () => {
            throw new Error("planner boom");
          },
          planFollowUp: async () => ({ stopped: true }),
        },
        search: {
          fetchContents: async () => {
            inFlightExa += 1;
            maxConcurrentExa = Math.max(maxConcurrentExa, inFlightExa);
            await pause(15);
            inFlightExa -= 1;
            return { docs: [] };
          },
          search: async () => {
            inFlightExa += 1;
            maxConcurrentExa = Math.max(maxConcurrentExa, inFlightExa);
            await pause(15);
            inFlightExa -= 1;
            return { docs: [doc("https://b.com/1")] };
          },
        },
        condenser: { condense: async () => ({ notes: ["n"], fallbackCount: 0 }) },
      },
    });
    expect(outcome.searched).toBe(true);
    // Zero parallel Exa calls even when explicit URLs and search run in Round 1!
    expect(maxConcurrentExa).toBe(1);
    expect(outcome.degraded?.join("; ")).toContain("explicit URLs could not be fetched");
    expect(outcome.degraded?.join("; ")).toContain("query planning failed");
  });

  it("reports how many rounds ran and where the time went", async () => {
    const writer = { write: () => {} } as never;
    const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    let searches = 0;
    let gapCalls = 0;
    const outcome = await runResearchPipeline({
      messages: [],
      query: "what happened",
      effort: effortConfig("medium"),
      stages,
      writer,
      requestId: "test1234",
      deps: {
        planner: {
          planQuery: async () => ({ stopped: false, query: "first" }),
          planFollowUp: async () => {
            gapCalls += 1;
            return gapCalls === 1 ? { stopped: false, query: "second" } : { stopped: true };
          },
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
          planQuery: async () => ({ stopped: false, query: "q" }),
          planFollowUp: async () => ({ stopped: true }),
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
    expect(outcome.degraded?.join(" ")).toContain("token budget");
  });

  it("runs sequential single-query rounds until the gap check says DONE", async () => {
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
          planQuery: async () => ({ stopped: false, query: "q1" }),
          planFollowUp: async ({ priorQueries }: { priorQueries: string[] }) => {
            gapPriors.push([...priorQueries]);
            gapCall += 1;
            if (gapCall === 1) return { stopped: false, query: "f1" };
            if (gapCall === 2) return { stopped: false, query: "f2" };
            return { stopped: true };
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
    expect(searchCalls).toEqual(["q1", "f1", "f2"]);
    expect(gapPriors).toEqual([["q1"], ["q1", "f1"], ["q1", "f1", "f2"]]);
    expect(outcome.totalSources).toBe(3);
    const doneRounds = chunks.filter((c) => c.data?.phase === "done").map((c) => c.data?.round);
    expect(doneRounds).toEqual([1, 2, 3]);
  });

  it("stops before the gap check once notes already fill the effort gather budget", async () => {
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
          planQuery: async () => ({ stopped: false, query: "q1" }),
          planFollowUp: async () => {
            gapCalls += 1;
            return { stopped: false, query: "f1" };
          },
        },
        search: {
          search: async () => ({ docs: [doc("https://a.com/1")] }),
          fetchContents: async () => ({ docs: [] }),
        },
        // ~9,000 tokens of notes, over the 8,500-token high-effort gather budget.
        condenser: { condense: async () => ({ notes: ["x".repeat(36_000)], fallbackCount: 0 }) },
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
          planQuery: async () => ({ stopped: false, query: "q1" }),
          planFollowUp: async ({ notes }: { notes: string }) => {
            gapNotes = notes;
            return { stopped: true };
          },
        },
        search: {
          search: async () => ({ docs: [doc("https://a.com/1")] }),
          fetchContents: async () => ({ docs: [] }),
        },
        // ~2,000 tokens: under the 3,000 evidence budget, over the 1,000-token gap budget.
        condenser: { condense: async () => ({ notes: ["x".repeat(8_000)], fallbackCount: 0 }) },
      },
    });
    expect(gapNotes.length).toBe(4_000);
  });

  it("uses all 3 rounds on medium effort and all 5 rounds on high effort when gaps keep coming", async () => {
    const runFor = async (level: "medium" | "high") => {
      const writer = { write: () => {} } as never;
      let gapCall = 0;
      let condenseCalls = 0;
      const outcome = await runResearchPipeline({
        messages: [],
        query: "q",
        effort: effortConfig(level),
        stages,
        writer,
        requestId: `rounds-${level}`,
        deps: {
          planner: {
            planQuery: async () => ({ stopped: false, query: "q1" }),
            planFollowUp: async () => {
              gapCall += 1;
              return { stopped: false, query: `f${gapCall}` };
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
      return { gapCall, condenseCalls, totalSources: outcome.totalSources };
    };

    // Medium: 3 rounds total (Round 1 + 2 follow-up rounds).
    const med = await runFor("medium");
    expect(med).toEqual({ condenseCalls: 3, gapCall: 2, totalSources: 3 });

    // High: 5 rounds total (Round 1 + 4 follow-up rounds).
    const high = await runFor("high");
    expect(high).toEqual({ condenseCalls: 5, gapCall: 4, totalSources: 5 });
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
          planQuery: async () => ({ stopped: false, query: "q" }),
          planFollowUp: async () => ({ stopped: true }),
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

  it("propagates planner BRIEF to condenser and gap-check", async () => {
    const writer = { write: () => {} } as never;
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
          planQuery: async () => ({
            stopped: false,
            brief: "Compare Q4 2026 operating margins of Nvidia and AMD",
            query: "nvidia q4 2026 operating margin filing",
          }),
          planFollowUp: async ({ query: gapQ }) => {
            gapQueries.push(gapQ);
            return { stopped: true };
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

    expect(condenseQueries).toEqual(["Compare Q4 2026 operating margins of Nvidia and AMD"]);
    expect(gapQueries).toEqual(["Compare Q4 2026 operating margins of Nvidia and AMD"]);
  });

  it("parses rerank indices and backfills missing slots deterministically", () => {
    expect(parseRerankIndices("<think>pick authority</think> 4, 2, 4, 99", 5, 3)).toEqual([
      3, 1, 0,
    ]);
    expect(parseRerankIndices("invalid output", 4, 2)).toEqual([0, 1]);
  });

  it("runs high-effort deep upgrades sequentially: 8 results/query + highlights, candidate reranking, citation hopping, and Thematic Reduce", async () => {
    const phases: string[] = [];
    const writer = {
      write: (c: { type?: string; data?: { phase?: string } }) => {
        if (c.type === "data-research-step" && c.data?.phase) {
          phases.push(c.data.phase);
        }
      },
    } as never;

    const searchCalls: Array<{ q: string; n: number; maxCharacters?: number; highlightsQuery?: string }> = [];
    const fetchedUrlBatches: string[][] = [];
    const callOrder: string[] = [];
    const seenCitedInGap: string[][] = [];
    let rerankCalled = 0;
    let reduceCalled = 0;

    const substantive = (url: string): ExaDocument => ({
      url,
      title: url,
      text: "empirical study findings ".repeat(30),
    });

    const outcome = await runResearchPipeline({
      messages: [],
      query: "deep comparison of solid-state battery longevity",
      effort: effortConfig("high"),
      stages,
      writer,
      requestId: "deep1234",
      deps: {
        planner: {
          planQuery: async () => ({
            stopped: false,
            brief: "Solid-state battery cycle life benchmarks vs Li-ion 2026",
            query: "solid state cycle life 2026",
          }),
          planFollowUp: async ({ citedPrimaryQueries }) => {
            if (citedPrimaryQueries) seenCitedInGap.push(citedPrimaryQueries);
            return fetchedUrlBatches.length === 0
              ? { stopped: false, query: "EXACT: Nature Energy 2026 solid-state degradation" }
              : { stopped: true };
          },
          rerankSources: async ({ candidates, maxSelect }) => {
            rerankCalled += 1;
            return [...candidates].reverse().slice(0, maxSelect);
          },
        },
        search: {
          search: async (q, n, ctx) => {
            callOrder.push(`search:${q}`);
            searchCalls.push({
              q,
              n,
              maxCharacters: ctx.maxCharacters,
              highlightsQuery: ctx.highlightsQuery,
            });
            return {
              docs: Array.from({ length: 6 }, (_, i) =>
                substantive(`https://domain-${searchCalls.length}-${i}.org/study`),
              ),
            };
          },
          fetchContents: async (urls) => {
            callOrder.push(`fetch:${urls.join(",")}`);
            fetchedUrlBatches.push(urls);
            return { docs: urls.map((u) => substantive(u)) };
          },
        },
        condenser: {
          condense: async (docs) => ({
            // ~2,000 tokens per round -> 4,000 tokens across 2 rounds (> 2,600 synthesis cap, < 8,500 gather cap!).
            notes: docs.map((d) => `### ${d.url}\nURL: ${d.url}\n- [Fact] ${"data ".repeat(400)}`),
            fallbackCount: 0,
            primaryRefs:
              fetchedUrlBatches.length === 0
                ? {
                    urls: ["https://arxiv.org/abs/2605.11111"],
                    queries: ["Nature Energy 2026 solid-state anode study"],
                  }
                : undefined,
          }),
          reduceNotes: async (notes) => {
            reduceCalled += 1;
            return {
              evidenceBlock: `### Distilled Brief (${notes.length} notes)\n- [Fact] Hopped [arXiv](https://arxiv.org/abs/2605.11111) confirmed 4,000 cycles.`,
              reduced: true,
            };
          },
        },
      },
    });

    // 1. Over-fetched 8 results/query with 20k chars + full-doc highlightsQuery set to BRIEF.
    expect(searchCalls[0]).toEqual({
      q: "solid state cycle life 2026",
      n: 8,
      maxCharacters: 20_000,
      highlightsQuery: "Solid-state battery cycle life benchmarks vs Li-ion 2026",
    });

    // 2. Strictly sequential order: Round 1 search -> Round 2 citation-hop fetch -> Round 2 search.
    expect(callOrder).toEqual([
      "search:solid state cycle life 2026",
      "fetch:https://arxiv.org/abs/2605.11111",
      "search:EXACT: Nature Energy 2026 solid-state degradation",
    ]);

    // 3. Reranked wider candidate pools & hopped directly to cited arXiv URL.
    expect(rerankCalled).toBeGreaterThanOrEqual(1);
    expect(phases).toContain("reranking");
    expect(fetchedUrlBatches).toEqual([["https://arxiv.org/abs/2605.11111"]]);
    expect(seenCitedInGap[0]).toEqual(["Nature Energy 2026 solid-state anode study"]);
    expect(outcome.sources.some((s) => s.url === "https://arxiv.org/abs/2605.11111")).toBe(true);

    // 4. Ran Thematic Reduce cleanly with zero degraded truncation.
    expect(reduceCalled).toBe(1);
    expect(phases).toContain("synthesizing");
    expect(outcome.evidenceBlock).toContain("Distilled Brief (8 notes)");
    expect(outcome.degraded).toBeUndefined();
  });
});
