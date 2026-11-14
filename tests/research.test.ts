import { describe, expect, it } from "vitest";
import {
  parsePlainTextLines,
  runResearchPipeline,
  selectDeduplicatedDocs,
} from "@/lib/research";
import { effortConfig } from "@/lib/effort";
import { serverConfig } from "@/lib/config";
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

describe("effortConfig parallelism vs rounds", () => {
  it("bounds parallel searches per round and gains depth from more rounds", () => {
    const medium = effortConfig("medium");
    const high = effortConfig("high");
    expect(medium).toMatchObject({ rounds: 2, queriesPerRound: 2, followUpQueries: 2, sourcesPerRound: 4, maxSources: 8 });
    expect(high).toMatchObject({ rounds: 4, queriesPerRound: 2, followUpQueries: 2, sourcesPerRound: 4, maxSources: 14 });
  });

  it("keeps model-call token budgets small enough to share Groq per-minute windows", () => {
    // Summarizer: Groq reserves the full output cap against a 1k OTPM limit,
    // so one round's batch must leave room for the next round's.
    expect(serverConfig.summary.batchMaxOutputTokens).toBeLessThanOrEqual(350);
    // Planner/gap run on a dedicated auxiliary model with low/none reasoning.
    expect(serverConfig.planner.maxOutputTokens).toBeLessThanOrEqual(300);
    expect(serverConfig.gapCheck.maxOutputTokens).toBeLessThanOrEqual(250);
    expect(serverConfig.gapCheck.notesTokenBudget).toBeLessThanOrEqual(1_000);
    // Summarizer input: a 20k-char batch requested 3.7-4.2k input tokens in
    // production, so round 2 busted the 7k ITPM window. ~10k chars keeps a
    // batch near 2k tokens, letting sequential rounds share the minute.
    expect(serverConfig.summary.batchInputCharCap).toBeLessThanOrEqual(10_000);
    expect(serverConfig.summary.perSourceInputCharCap).toBeLessThanOrEqual(3_000);
    // Synthesis cap counts reasoning tokens too (~700 observed); 3,500 fits
    // the 8k TPM window alongside the ~2.9k-token evidence-capped input.
    expect(serverConfig.synthesis.maxOutputTokens).toBeLessThanOrEqual(3_500);
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
      plannerModel: {} as never,
      summaryModel: {} as never,
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
      plannerModel: {} as never,
      summaryModel: {} as never,
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
      plannerModel: {} as never,
      summaryModel: {} as never,
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

  it("trims the evidence block to the synthesis token budget and discloses it", async () => {
    const writer = { write: () => {} } as never;
    const bigNote = "x".repeat(30_000); // ~7,500 tokens, over the 3,000 budget
    const outcome = await runResearchPipeline({
      messages: [],
      query: "q",
      effort: effortConfig("medium"),
      plannerModel: {} as never,
      summaryModel: {} as never,
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

  it("runs narrow sequential rounds until the gap check says DONE, never exceeding 2 parallel searches", async () => {
    const chunks: { data?: { round?: number; phase?: string } }[] = [];
    const writer = { write: (c: unknown) => chunks.push(c as never) } as never;
    const searchCalls: string[] = [];
    const gapPriors: string[][] = [];
    let active = 0;
    let maxActive = 0;
    let gapCall = 0;
    const outcome = await runResearchPipeline({
      messages: [],
      query: "q",
      effort: effortConfig("high"),
      plannerModel: {} as never,
      summaryModel: {} as never,
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
            active += 1;
            maxActive = Math.max(maxActive, active);
            await new Promise((r) => setTimeout(r, 5));
            active -= 1;
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
    expect(maxActive).toBeLessThanOrEqual(2);
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
      plannerModel: {} as never,
      summaryModel: {} as never,
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
      plannerModel: {} as never,
      summaryModel: {} as never,
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
      plannerModel: {} as never,
      summaryModel: {} as never,
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
      plannerModel: {} as never,
      summaryModel: {} as never,
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
