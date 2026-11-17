import { describe, expect, it } from "vitest";
import {
  budgetNotesFairly,
  buildPlannerPromptFromMessages,
  parsePlainTextQuery,
  parseQueryPlan,
  runResearchPipeline,
  selectDeduplicatedDocs,
} from "@/lib/research";
import { effortConfig } from "@/lib/effort";
import type { ExaDocument } from "@/lib/exa";
import type { StageRunner } from "@/lib/agent/stage";
import type { ResearchStepData } from "@/lib/types/chat";

const doc = (url: string): ExaDocument => ({
  url,
  title: url,
  text: "substantive document text ".repeat(8),
});

const unusedStage = (id: string): StageRunner => ({
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

describe("parsePlainTextQuery & parseQueryPlan", () => {
  it("parses stop tokens and skips excluded prior queries", () => {
    expect(parsePlainTextQuery("NO_SEARCH", { stopToken: "NO_SEARCH" })).toEqual({
      stopped: true,
    });
    expect(parsePlainTextQuery("`DONE.`", { stopToken: "DONE" })).toEqual({
      stopped: true,
    });
    expect(
      parsePlainTextQuery("1. alpha query\n- beta query", {
        stopToken: "DONE",
        exclude: ["Alpha Query"],
      }),
    ).toEqual({ stopped: false, query: "beta query" });
  });

  it("extracts BRIEF line and initial query, strips QUERY: prefixes, ignores markdown headings, and formats follow-up transcripts", () => {
    const raw = [
      "<think>resolve pronouns</think>",
      "BRIEF: Compare Acme Corp and Beta Inc Q4 2026 operating margins",
      "QUERY: Acme Corp vs Beta Inc Q4 2026 operating margin filing",
    ].join("\n");
    expect(parseQueryPlan(raw)).toEqual({
      stopped: false,
      brief: "Compare Acme Corp and Beta Inc Q4 2026 operating margins",
      query: "Acme Corp vs Beta Inc Q4 2026 operating margin filing",
    });
    expect(parseQueryPlan("## Accidental Heading\nreal search query 2026")).toEqual({
      stopped: false,
      query: "real search query 2026",
    });
    expect(parseQueryPlan("NO_SEARCH")).toEqual({ stopped: true });
    expect(
      parseQueryPlan(
        "BRIEF: Summarize the prior comparison into 3 bullets\nNO_SEARCH",
      ),
    ).toEqual({
      stopped: true,
      brief: "Summarize the prior comparison into 3 bullets",
    });

    const plannerPrompt = buildPlannerPromptFromMessages([
      { role: "user", content: "Tell me about QuantumScape batteries" },
      { role: "assistant", content: "QuantumScape's QSE-5 cell uses a ceramic separator." },
      { role: "user", content: "How fast does it charge in cold weather?" },
    ]);
    expect(plannerPrompt).toContain("Prior conversation context");
    expect(plannerPrompt).toContain("QuantumScape's QSE-5");
    expect(plannerPrompt).toContain(
      "Latest user message (plan search for THIS message):\nHow fast does it charge in cold weather?",
    );
  });
});

describe("selectDeduplicatedDocs", () => {
  it("dedupes URLs, drops empty pages, enforces domain diversity, and backfills when sparse", () => {
    const seen = new Set<string>();
    const diverse = selectDeduplicatedDocs(
      [doc("https://p.com/explicit")],
      [
        { url: "https://empty.org/dead", title: "Dead", text: "   " },
        doc("https://www.vendor.com/p1"),
        doc("https://blog.vendor.com/p2"),
        doc("https://docs.vendor.com/p3"),
        doc("https://independent.edu/study"),
      ],
      seen,
      4,
    );
    expect(diverse.map((d) => d.url)).toEqual([
      "https://p.com/explicit",
      "https://www.vendor.com/p1",
      "https://blog.vendor.com/p2",
      "https://independent.edu/study",
    ]);

    const sparseSeen = new Set<string>();
    const backfilled = selectDeduplicatedDocs(
      [],
      [doc("https://onlydomain.com/1"), doc("https://onlydomain.com/2"), doc("https://onlydomain.com/3")],
      sparseSeen,
      3,
    );
    expect(backfilled).toHaveLength(3);
  });
});

describe("budgetNotesFairly", () => {
  it("sheds irrelevant notes first and preserves short later-round notes via water-filling", () => {
    const round1Long = "R1 ".repeat(3_500);
    const round1Irrelevant = "### Off-topic\nURL: https://x.com\n- Irrelevant to research question.";
    const round2Concise = "### Round 2 Gap Fill\nURL: https://r2.org\n- [Fact] Exact figure is 93.4%.";

    const out = budgetNotesFairly(
      [round1Long, round1Irrelevant, round2Concise],
      1_500,
      { separator: "\n\n---\n\n", labelSources: true, trimMarker: "[Trimmed]" },
    );

    expect(out.text).not.toContain("Irrelevant to research question");
    expect(out.text).toContain("Exact figure is 93.4%.");
    expect(out.text).toContain("[Trimmed]");
    expect(out.trimmedCount).toBe(2);
  });
});

describe("runResearchPipeline", () => {
  it("surfaces failed queries and condenser fallbacks across sequential rounds", async () => {
    let lastSteps: ResearchStepData[] = [];
    let gapCalls = 0;
    const outcome = await runResearchPipeline({
      messages: [],
      query: "what happened",
      effort: effortConfig("medium"),
      stages,
      onProgress: ({ steps }) => {
        lastSteps = steps;
      },
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
    expect(lastSteps.at(-1)?.degraded).toBeTruthy();
  });

  it("flags total retrieval failure as searchFailed, distinct from NO_SEARCH", async () => {
    const outcome = await runResearchPipeline({
      messages: [],
      query: "breaking news",
      effort: effortConfig("medium"),
      stages,
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

  it("executes fetchContents and search sequentially and propagates planner BRIEF to Exa highlightsQuery", async () => {
    let inFlightExa = 0;
    let maxConcurrentExa = 0;
    const seenHighlightsQueries: Array<string | undefined> = [];
    const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

    const outcome = await runResearchPipeline({
      messages: [],
      query: "summarise https://a.com/page please",
      effort: effortConfig("high"),
      stages,
      requestId: "test1234",
      deps: {
        planner: {
          planQuery: async () => ({
            stopped: false,
            brief: "Compare Q4 2026 operating margins",
            query: "q4 2026 operating margin",
          }),
          planFollowUp: async () => ({ stopped: true }),
        },
        search: {
          fetchContents: async (_urls, ctx) => {
            inFlightExa += 1;
            maxConcurrentExa = Math.max(maxConcurrentExa, inFlightExa);
            seenHighlightsQueries.push(ctx.highlightsQuery);
            await pause(10);
            inFlightExa -= 1;
            return { docs: [] };
          },
          search: async (_q, _n, ctx) => {
            inFlightExa += 1;
            maxConcurrentExa = Math.max(maxConcurrentExa, inFlightExa);
            seenHighlightsQueries.push(ctx.highlightsQuery);
            await pause(10);
            inFlightExa -= 1;
            return { docs: [doc("https://b.com/1")] };
          },
        },
        condenser: { condense: async () => ({ notes: ["n"], fallbackCount: 0 }) },
      },
    });
    expect(outcome.searched).toBe(true);
    expect(maxConcurrentExa).toBe(1);
    expect(seenHighlightsQueries).toEqual([
      "Compare Q4 2026 operating margins",
      "Compare Q4 2026 operating margins",
    ]);
    expect(outcome.degraded?.join("; ")).toContain("explicit URLs could not be fetched");
  });

  it("uses up to 3 rounds on medium effort and 5 rounds on high effort", async () => {
    const runFor = async (level: "medium" | "high") => {
      let gapCall = 0;
      let condenseCalls = 0;
      const outcome = await runResearchPipeline({
        messages: [],
        query: "q",
        effort: effortConfig(level),
        stages,
        requestId: `rounds-${level}`,
        deps: {
          planner: {
            planQuery: async () => ({ stopped: false, query: "q1" }),
            planFollowUp: async () => ({ stopped: false, query: `f${++gapCall}` }),
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
      return { gapCall, condenseCalls, rounds: outcome.steps.length };
    };

    expect(await runFor("medium")).toEqual({ condenseCalls: 3, gapCall: 2, rounds: 3 });
    expect(await runFor("high")).toEqual({ condenseCalls: 5, gapCall: 4, rounds: 5 });
  });

  it("stops starting additional follow-up rounds when approaching deadlineAt so synthesis still completes", async () => {
    let gapCalls = 0;
    const outcome = await runResearchPipeline({
      messages: [],
      query: "deep topic",
      effort: effortConfig("high"),
      stages,
      deadlineAt: Date.now() + 20_000, // < 45s reserve for final synthesis
      requestId: "deadline-check",
      deps: {
        planner: {
          planQuery: async () => ({ stopped: false, query: "q1" }),
          planFollowUp: async () => {
            gapCalls += 1;
            return { stopped: false, query: "q2" };
          },
        },
        search: {
          search: async () => ({ docs: [doc("https://a.com/1")] }),
          fetchContents: async () => ({ docs: [] }),
        },
        condenser: {
          condense: async () => ({ notes: ["round 1 note"], fallbackCount: 0 }),
        },
      },
    });
    expect(outcome.searched).toBe(true);
    expect(gapCalls).toBe(0);
    expect(outcome.steps).toHaveLength(1);
    expect(outcome.degraded?.join("; ")).toContain("skipped to leave time for final synthesis");
  });
});
